// Game state shared between execution environments.
//
// Any environment can receive any request, so a game's state lives in one
// DynamoDB table instead of process memory. Per game (pk = game#<id>):
//
//   sk = lease          who runs the game now: owner (environment id), gen
//                       (bumped on every ownership change), heartbeatAt, tic
//                       (last tic whose inputs are all in the log), seqs (last
//                       input batch applied, per browser tab), want (an
//                       environment asking to take over)
//   sk = log#<tic>      key events the owner applied, written in batches, each
//                       event [tic, key, pressed]. Replaying them from tic 0
//                       rebuilds the game exactly (the engine is deterministic).
//                       Spectators on other environments follow a game by
//                       reading new batches as they land.
//   sk = in#<ms>#<cid>#<seq>  input that reached an environment not running the
//                       game, waiting for the owner to pick it up
//
// The owner writes log batches and its heartbeat in one transaction that only
// succeeds while it still holds the lease, so a game can never have two writers.
// Every item carries expiresAt and DynamoDB's TTL deletes finished games.
//
// MemoryStore implements the same interface in-process for local development
// without AWS (one process = one environment, so no handoffs happen).

import crypto from 'node:crypto';

const GAME_TTL_S = 6 * 3600;
const INBOX_TTL_S = 600;
const pad = (n, w) => String(n).padStart(w, '0');
const expires = (s) => Math.floor(Date.now() / 1000) + s;

// A game's id lets you play it, so spectators get a token derived one way from
// it: knowing the token doesn't give you the id. The browser computes the same
// value (public/client.js) to build the watch link.
export const watchToken = (id) => crypto.createHash('sha256').update(`watch:${id}`).digest('hex').slice(0, 32);

export class LeaseLost extends Error {}

export async function createStore() {
  const table = process.env.TABLE_NAME;
  if (!table) {
    console.log('TABLE_NAME not set: using in-memory store (single environment only)');
    return new MemoryStore();
  }
  const ddb = await import('@aws-sdk/client-dynamodb');
  return new DynamoStore(ddb, table);
}

// ---------------------------------------------------------------- DynamoDB

// Minimal attribute-value marshalling for the shapes this file uses.
const toAttr = (v) => {
  if (typeof v === 'number') return { N: String(v) };
  if (typeof v === 'string') return { S: v };
  return { S: JSON.stringify(v) }; // objects and arrays are stored as JSON strings
};
const leaseFrom = (item) => item && {
  owner: item.owner?.S,
  gen: Number(item.gen?.N ?? 0),
  heartbeatAt: Number(item.heartbeatAt?.N ?? 0),
  tic: Number(item.tic?.N ?? 0),
  seqs: item.seqs ? JSON.parse(item.seqs.S) : {},
  want: item.want?.S,
};

class DynamoStore {
  constructor(ddb, table) {
    this.ddb = ddb;
    this.table = table;
    this.client = new ddb.DynamoDBClient({});
  }

  key(id, sk) {
    return { pk: { S: `game#${id}` }, sk: { S: sk } };
  }

  async getLease(id) {
    const r = await this.client.send(new this.ddb.GetItemCommand({
      TableName: this.table, Key: this.key(id, 'lease'), ConsistentRead: true,
    }));
    return leaseFrom(r.Item);
  }

  // First owner of a new game. Returns false if the game already exists. Also
  // records the game's watch token, so spectators can find it without its id.
  async createLease(id, me) {
    try {
      await this.client.send(new this.ddb.TransactWriteItemsCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                ...this.key(id, 'lease'),
                owner: toAttr(me), gen: toAttr(1), heartbeatAt: toAttr(Date.now()), tic: toAttr(0),
                seqs: toAttr({}), expiresAt: toAttr(expires(GAME_TTL_S)),
              },
              ConditionExpression: 'attribute_not_exists(pk)',
            },
          },
          {
            Put: {
              TableName: this.table,
              Item: { pk: { S: `watch#${watchToken(id)}` }, sk: { S: 'game' }, game: toAttr(id), expiresAt: toAttr(expires(GAME_TTL_S)) },
            },
          },
        ],
      }));
      return true;
    } catch (e) {
      if (e.name === 'TransactionCanceledException' && e.CancellationReasons?.[0]?.Code === 'ConditionalCheckFailed') return false;
      throw e;
    }
  }

  // The game id behind a watch token, or null.
  async gameForWatch(token) {
    const r = await this.client.send(new this.ddb.GetItemCommand({
      TableName: this.table, Key: { pk: { S: `watch#${token}` }, sk: { S: 'game' } },
    }));
    return r.Item?.game?.S ?? null;
  }

  // Ask the current owner to hand the game over at its next heartbeat.
  async requestHandoff(id, me, gen) {
    try {
      await this.client.send(new this.ddb.UpdateItemCommand({
        TableName: this.table, Key: this.key(id, 'lease'),
        UpdateExpression: 'SET want = :me',
        ConditionExpression: 'gen = :g',
        ExpressionAttributeValues: { ':me': toAttr(me), ':g': toAttr(gen) },
      }));
      return true;
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return false;
      throw e;
    }
  }

  // Take the game from an owner that stopped answering. Succeeds only if
  // nobody else changed the lease since we read generation `gen`.
  async takeOver(id, me, gen) {
    try {
      const r = await this.client.send(new this.ddb.UpdateItemCommand({
        TableName: this.table, Key: this.key(id, 'lease'),
        UpdateExpression: 'SET #o = :me, gen = gen + :one, heartbeatAt = :now REMOVE want',
        ConditionExpression: 'gen = :g',
        ExpressionAttributeNames: { '#o': 'owner' },
        ExpressionAttributeValues: { ':me': toAttr(me), ':one': toAttr(1), ':now': toAttr(Date.now()), ':g': toAttr(gen) },
        ReturnValues: 'ALL_NEW',
      }));
      return leaseFrom(r.Attributes);
    } catch (e) {
      if (e.name === 'ConditionalCheckFailedException') return null;
      throw e;
    }
  }

  // Owner's periodic write. Returns { ok: true } or { want } when another
  // environment asked for the game. Throws LeaseLost if we no longer own it.
  async heartbeat(id, me, gen, { tic, seqs, firstTic, events }) {
    const items = this.logPut(id, firstTic, events);
    items.push({
      Update: {
        TableName: this.table, Key: this.key(id, 'lease'),
        UpdateExpression: 'SET heartbeatAt = :now, tic = :tic, seqs = :seqs, expiresAt = :exp',
        ConditionExpression: '#o = :me AND gen = :g AND attribute_not_exists(want)',
        ExpressionAttributeNames: { '#o': 'owner' },
        ExpressionAttributeValues: {
          ':now': toAttr(Date.now()), ':tic': toAttr(tic), ':seqs': toAttr(seqs),
          ':exp': toAttr(expires(GAME_TTL_S)), ':me': toAttr(me), ':g': toAttr(gen),
        },
        ReturnValuesOnConditionCheckFailure: 'ALL_OLD',
      },
    });
    try {
      await this.client.send(new this.ddb.TransactWriteItemsCommand({ TransactItems: items }));
      return { ok: true };
    } catch (e) {
      if (e.name !== 'TransactionCanceledException') throw e;
      const reason = e.CancellationReasons?.[items.length - 1];
      const current = leaseFrom(reason?.Item);
      if (current && current.owner === me && current.gen === gen && current.want) return { want: current.want };
      throw new LeaseLost(`lease for ${id} moved to ${current?.owner} gen ${current?.gen}`);
    }
  }

  // Final flush, then give the game to `to`. After this we must stop running it.
  async handOff(id, me, gen, to, { tic, seqs, firstTic, events }) {
    const items = this.logPut(id, firstTic, events);
    items.push({
      Update: {
        TableName: this.table, Key: this.key(id, 'lease'),
        UpdateExpression: 'SET #o = :to, gen = gen + :one, heartbeatAt = :now, tic = :tic, seqs = :seqs REMOVE want',
        ConditionExpression: '#o = :me AND gen = :g',
        ExpressionAttributeNames: { '#o': 'owner' },
        ExpressionAttributeValues: {
          ':to': toAttr(to), ':one': toAttr(1), ':now': toAttr(Date.now()), ':tic': toAttr(tic),
          ':seqs': toAttr(seqs), ':me': toAttr(me), ':g': toAttr(gen),
        },
      },
    });
    await this.client.send(new this.ddb.TransactWriteItemsCommand({ TransactItems: items }));
  }

  logPut(id, firstTic, events) {
    if (!events.length) return [];
    return [{
      Put: {
        TableName: this.table,
        Item: { ...this.key(id, `log#${pad(firstTic, 9)}`), events: toAttr(events), expiresAt: toAttr(expires(GAME_TTL_S)) },
      },
    }];
  }

  // Every logged event, in tic order.
  async readLog(id) {
    return (await this.readLogAfter(id, null)).events;
  }

  // Logged events in batches after `cursor` (null = from the start), in tic
  // order, plus the cursor to pass next time. Spectators use this to follow a
  // game a batch at a time.
  async readLogAfter(id, cursor) {
    const events = [];
    let start = cursor ? this.key(id, cursor) : undefined;
    let last = cursor;
    do {
      const r = await this.client.send(new this.ddb.QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :p)',
        ExpressionAttributeValues: { ':pk': { S: `game#${id}` }, ':p': { S: 'log#' } },
        ConsistentRead: true,
        ExclusiveStartKey: start,
      }));
      for (const item of r.Items) {
        events.push(...JSON.parse(item.events.S));
        last = item.sk.S;
      }
      start = r.LastEvaluatedKey;
    } while (start);
    return { events, cursor: last };
  }

  async putInbox(id, cid, seq, keys) {
    await this.client.send(new this.ddb.PutItemCommand({
      TableName: this.table,
      Item: {
        ...this.key(id, `in#${pad(Date.now(), 13)}#${cid}#${pad(seq, 9)}`),
        keys: toAttr(keys), expiresAt: toAttr(expires(INBOX_TTL_S)),
      },
    }));
  }

  // Inbox items written at or after `sinceMs`. Callers drop duplicates by seq.
  async pollInbox(id, sinceMs) {
    const r = await this.client.send(new this.ddb.QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'pk = :pk AND sk BETWEEN :from AND :to',
      ExpressionAttributeValues: {
        ':pk': { S: `game#${id}` }, ':from': { S: `in#${pad(Math.max(0, sinceMs), 13)}` }, ':to': { S: 'in#~' },
      },
      ConsistentRead: true,
    }));
    return r.Items.map((item) => {
      const [, , cid, seq] = item.sk.S.split('#');
      return { cid, seq: Number(seq), keys: JSON.parse(item.keys.S) };
    });
  }
}

// ---------------------------------------------------------------- in-memory

class MemoryStore {
  constructor() {
    this.leases = new Map();
    this.logs = new Map();
    this.inbox = new Map();
    this.watch = new Map();
  }

  async getLease(id) {
    const l = this.leases.get(id);
    return l && structuredClone(l);
  }

  async createLease(id, me) {
    if (this.leases.has(id)) return false;
    this.leases.set(id, { owner: me, gen: 1, heartbeatAt: Date.now(), tic: 0, seqs: {} });
    this.logs.set(id, []);
    this.watch.set(watchToken(id), id);
    return true;
  }

  async gameForWatch(token) {
    return this.watch.get(token) ?? null;
  }

  async requestHandoff(id, me, gen) {
    const l = this.leases.get(id);
    if (!l || l.gen !== gen) return false;
    l.want = me;
    return true;
  }

  async takeOver(id, me, gen) {
    const l = this.leases.get(id);
    if (!l || l.gen !== gen) return null;
    Object.assign(l, { owner: me, gen: gen + 1, heartbeatAt: Date.now() });
    delete l.want;
    return structuredClone(l);
  }

  async heartbeat(id, me, gen, { tic, seqs, events }) {
    const l = this.leases.get(id);
    if (!l || l.owner !== me || l.gen !== gen) throw new LeaseLost(`lease for ${id} moved`);
    if (l.want) return { want: l.want };
    this.logs.get(id).push(...events);
    Object.assign(l, { heartbeatAt: Date.now(), tic, seqs });
    return { ok: true };
  }

  async handOff(id, me, gen, to, { tic, seqs, events }) {
    const l = this.leases.get(id);
    if (!l || l.owner !== me || l.gen !== gen) throw new LeaseLost(`lease for ${id} moved`);
    this.logs.get(id).push(...events);
    Object.assign(l, { owner: to, gen: gen + 1, heartbeatAt: Date.now(), tic, seqs });
    delete l.want;
  }

  async readLog(id) {
    return [...(this.logs.get(id) || [])];
  }

  async readLogAfter(id, cursor) {
    const log = this.logs.get(id) || [];
    const from = cursor ?? 0;
    return { events: log.slice(from), cursor: log.length };
  }

  async putInbox(id, cid, seq, keys) {
    if (!this.inbox.has(id)) this.inbox.set(id, []);
    this.inbox.get(id).push({ at: Date.now(), cid, seq, keys });
  }

  async pollInbox(id, sinceMs) {
    return (this.inbox.get(id) || []).filter((m) => m.at >= sinceMs);
  }
}
