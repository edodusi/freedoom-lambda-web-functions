// Doom on AWS Lambda Web Functions: the game runs on the server and the browser
// gets a stream of frames back.
//
//   POST /api/games               new game id
//   GET  /api/games/:id/stream    long-lived binary frame stream (see public/client.js)
//   GET  /api/watch/:token/stream the same stream for a spectator (no controls)
//   POST /api/games/:id/input     { cid, seq, keys: [[doomKey, pressed], ...] }
//   GET  /api/ping                tiny reply the browser times for latency; reports the Region
//   GET  /healthz
//
// Any execution environment can serve any request. The environment that holds
// the stream runs the game ("owns" it); ownership, input and an input log live
// in DynamoDB (store.js). When a stream reconnects to a different environment,
// that environment asks the owner to hand over, then rebuilds the game by
// replaying the log. The engine is deterministic, so the rebuilt game is the
// same game, on the same tic.
//
// Spectators never take a game over. On the owner's environment they get the
// owner's frames. Anywhere else the environment runs its own copy of the game
// (a Follower) that replays the log as the owner writes it, about a second
// behind. Only inputs cross environments, never frames.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { DoomEngine, TICRATE, isDoomKey } from './engine.js';
import { createStore, LeaseLost } from './store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(HERE, 'public');

// On Lambda the runtime sets AWS_LAMBDA_HTTP_ENDPOINT. Locally, loopback only.
const [HOST, PORT] = (process.env.AWS_LAMBDA_HTTP_ENDPOINT || `127.0.0.1:${process.env.PORT || 3000}`).split(':');
const MAX_GAMES = Number(process.env.MAX_GAMES || 16); // games run by one environment
const IDLE_MS = 60_000; // a game with no viewer for this long is released
const HEARTBEAT_MS = 500; // owner flushes the input log this often
const INBOX_POLL_MS = 60; // owner checks for input that reached other environments
const STALE_MS = 2500; // an owner silent this long is presumed gone
const HANDOFF_WAIT_MS = 3000;
const REORDER_WAIT_MS = 300; // how long to wait for a missing input batch
const MAX_INPUT_BYTES = 4096;
const RELEASED = 'released';
const MAX_FOLLOWERS = Number(process.env.MAX_FOLLOWERS || 16); // spectated games copied here
const MAX_SPECTATORS = Number(process.env.MAX_SPECTATORS || 16); // spectator streams served here (each one costs bandwidth like a player)
const FOLLOW_POLL_MS = 250; // a follower checks for new log batches this often
const FOLLOW_BUFFER_TICS = 25; // a follower starts this far behind, so short gaps don't stall it
const FOLLOW_CATCHUP_TICS = 70; // further behind than this, it plays at double speed
const FOLLOWER_IDLE_MS = 10_000; // a follower with no spectators for this long is dropped

// Identifies this execution environment (this process) in the lease.
const ENV_ID = crypto.randomUUID().slice(0, 8);
const store = await createStore();
const games = new Map(); // id -> Game, only games this environment owns
const acquiring = new Map(); // id -> Promise<Game>
const followers = new Map(); // id -> Follower, spectated games owned elsewhere
const following = new Map(); // id -> Promise<Follower>

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Game {
  constructor(id, engine, lease, info) {
    this.id = id;
    this.engine = engine;
    this.gen = lease.gen;
    this.seqs = { ...lease.seqs }; // last applied input batch per browser tab
    this.buffers = new Map(); // cid -> Map(seq -> { keys, at })
    this.events = []; // applied key events not yet in the log
    this.firstTic = null;
    this.viewers = new Set();
    this.lastViewerAt = Date.now();
    this.palette = info.palette;
    this.info = info; // { replayedTics, replayMs, handoff }
    this.stopped = false;
    this.inboxCursor = Date.now() - 5000;
    this.heartbeatLoop();
    this.inboxLoop();
  }

  // An input batch from a browser tab. Batches are applied in seq order, even
  // when some arrive here directly and others come through the DynamoDB inbox.
  offer(cid, seq, keys) {
    if (seq <= (this.seqs[cid] ?? 0)) return;
    if (!this.buffers.has(cid)) this.buffers.set(cid, new Map());
    const buf = this.buffers.get(cid);
    if (!buf.has(seq)) buf.set(seq, { keys, at: Date.now() });
  }

  collect() {
    const out = [];
    const now = Date.now();
    for (const [cid, buf] of this.buffers) {
      let next = (this.seqs[cid] ?? 0) + 1;
      if (!buf.has(next) && buf.size) {
        // A batch is missing. Wait a little for it, then skip past it.
        const oldest = Math.min(...[...buf.values()].map((b) => b.at));
        if (now - oldest > REORDER_WAIT_MS) next = Math.min(...buf.keys());
      }
      while (buf.has(next)) {
        out.push(...buf.get(next).keys);
        buf.delete(next);
        this.seqs[cid] = next;
        next++;
      }
      if (!buf.size) this.buffers.delete(cid);
    }
    return out;
  }

  step() {
    const keys = this.collect();
    this.engine.step(keys);
    if (keys.length) {
      if (this.firstTic === null) this.firstTic = this.engine.tic;
      for (const [k, p] of keys) this.events.push([this.engine.tic, k, p ? 1 : 0]);
    }
    const changed = this.engine.paletteIfChanged();
    if (changed) this.palette = Buffer.from(changed);
    // Only players keep a game alive; spectators alone don't stop it idling out.
    if (this.hasPlayer()) this.lastViewerAt = Date.now();
    for (const v of this.viewers) v.send(this);
  }

  hasPlayer() {
    for (const v of this.viewers) if (!v.spectator) return true;
    return false;
  }

  takeBatch() {
    const batch = { tic: this.engine.tic, seqs: { ...this.seqs }, firstTic: this.firstTic ?? this.engine.tic, events: this.events };
    this.events = [];
    this.firstTic = null;
    return batch;
  }

  putBack(batch) {
    this.events = batch.events.concat(this.events);
    if (batch.events.length) this.firstTic = batch.firstTic;
  }

  async heartbeatLoop() {
    while (!this.stopped) {
      await sleep(HEARTBEAT_MS);
      if (this.stopped) return;
      const batch = this.takeBatch();
      try {
        const r = await store.heartbeat(this.id, ENV_ID, this.gen, batch);
        if (r.want) {
          this.stop(`handed off to ${r.want}`);
          const final = this.takeBatch();
          await store.handOff(this.id, ENV_ID, this.gen, r.want, merge(batch, final));
          console.log(JSON.stringify({ msg: 'handoff', game: this.id, to: r.want, tic: final.tic }));
        }
      } catch (e) {
        if (e instanceof LeaseLost) { this.stop('lease lost'); return; }
        if (!this.stopped) this.putBack(batch); // transient error: retry next time
        console.error(JSON.stringify({ msg: 'heartbeat failed', game: this.id, error: e.message }));
      }
    }
  }

  async inboxLoop() {
    while (!this.stopped) {
      await sleep(INBOX_POLL_MS);
      const since = this.inboxCursor;
      this.inboxCursor = Date.now() - 2000; // overlap covers clock skew between environments
      try {
        for (const m of await store.pollInbox(this.id, since)) this.offer(m.cid, m.seq, m.keys);
      } catch (e) {
        this.inboxCursor = since;
        console.error(JSON.stringify({ msg: 'inbox poll failed', game: this.id, error: e.message }));
      }
    }
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (games.get(this.id) === this) games.delete(this.id);
    for (const v of this.viewers) {
      v.send(this, true); // the tic this game stopped on, so the next environment's first frame follows on
      v.close();
    }
    this.viewers.clear();
    console.log(JSON.stringify({ msg: 'stopped', game: this.id, reason, tic: this.engine.tic }));
  }

  // Give the game up with a final flush, so the next environment takes over
  // without waiting for this one.
  async release(reason) {
    if (this.stopped) return;
    this.stop(reason);
    try {
      await store.handOff(this.id, ENV_ID, this.gen, RELEASED, this.takeBatch());
    } catch (e) {
      console.error(JSON.stringify({ msg: 'release failed', game: this.id, error: e.message }));
    }
  }
}

function merge(a, b) {
  return {
    tic: b.tic,
    seqs: b.seqs,
    firstTic: a.events.length ? a.firstTic : b.firstTic,
    events: a.events.concat(b.events),
  };
}

// Rebuild a game from its log, up to the tic the last owner reached. Yields to
// the event loop now and then so other games here keep running.
async function rebuild(id, lease, handoff) {
  const t0 = performance.now();
  const engine = new DoomEngine();
  const events = await store.readLog(id);
  const { palette } = await replay(engine, events, lease.tic);
  const info = { replayedTics: lease.tic, replayMs: Math.round(performance.now() - t0), handoff };
  console.log(JSON.stringify({ msg: 'rebuilt', game: id, ...info, events: events.length }));
  return start(id, engine, lease, { ...info, palette });
}

// Step `engine` up to tic `until`, applying logged events [tic, key, pressed]
// at their tics. Returns the index of the first event not applied yet and the
// last palette the game set.
async function replay(engine, events, until) {
  let i = 0;
  let palette = null;
  while (engine.tic < until) {
    const keys = [];
    for (; i < events.length && events[i][0] <= engine.tic + 1; i++) {
      if (events[i][0] === engine.tic + 1) keys.push([events[i][1], events[i][2] === 1]);
    }
    engine.step(keys);
    const p = engine.paletteIfChanged();
    if (p) palette = Buffer.from(p);
    if (engine.tic % 2000 === 0) await new Promise((r) => setImmediate(r));
  }
  return { next: i, palette };
}

function start(id, engine, lease, info) {
  const game = new Game(id, engine, lease, info);
  games.set(id, game);
  // Spectators watching a copy here move to the real game.
  const copy = followers.get(id);
  if (copy) {
    for (const v of copy.viewers) game.viewers.add(v);
    copy.stop('owner is here now', { keepViewers: true });
  }
  return game;
}

// Make this environment the game's owner.
async function acquire(id) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const lease = await store.getLease(id);
    if (!lease) {
      if (await store.createLease(id, ENV_ID)) {
        return start(id, new DoomEngine(), { gen: 1, seqs: {} }, { replayedTics: 0, replayMs: 0, handoff: 'new' });
      }
      continue;
    }
    const local = games.get(id);
    if (local && lease.owner === ENV_ID && lease.gen === local.gen) return local;
    if (local) local.stop('stale copy');

    // Nobody is running it (released, gone quiet, or a copy we dropped): take it.
    if (lease.owner === ENV_ID || lease.owner === RELEASED || Date.now() - lease.heartbeatAt > STALE_MS) {
      const taken = await store.takeOver(id, ENV_ID, lease.gen);
      if (taken) return rebuild(id, taken, lease.owner === RELEASED ? 'released' : 'takeover');
      continue;
    }

    // Another environment is running it: ask for a handoff and wait.
    if (!(await store.requestHandoff(id, ENV_ID, lease.gen))) continue;
    const deadline = Date.now() + HANDOFF_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(100);
      const now = await store.getLease(id);
      if (now.owner === ENV_ID && now.gen > lease.gen) return rebuild(id, now, `handoff from ${lease.owner}`);
      if (now.gen !== lease.gen) break; // someone else got it; start over
      if (Date.now() - now.heartbeatAt > STALE_MS) break; // owner went quiet: take over now
    }
    const taken = await store.takeOver(id, ENV_ID, lease.gen);
    if (taken) return rebuild(id, taken, 'takeover');
  }
  throw new Error('could not take ownership of the game');
}

function acquireOnce(id) {
  if (!acquiring.has(id)) {
    acquiring.set(id, acquire(id).finally(() => acquiring.delete(id)));
  }
  return acquiring.get(id);
}

// A spectator's copy of a game that another environment owns. It replays the
// owner's input log as batches land in DynamoDB, so it shows the same game a
// little behind. It never writes anything.
class Follower {
  constructor(id, engine, { palette, cursor, events, target, info }) {
    this.id = id;
    this.engine = engine;
    this.palette = palette;
    this.cursor = cursor; // last log batch read
    this.events = events; // logged events not applied yet, in tic order
    this.target = target; // the owner's last flushed tic: inputs up to here are all known
    this.info = info;
    this.viewers = new Set();
    this.lastViewerAt = Date.now();
    this.stopped = false;
    this.pollLoop();
  }

  // Called by the main loop once per tic: play at game speed while the log is
  // ahead, at double speed when far behind, and wait when it runs out.
  step() {
    const behind = this.target - this.engine.tic;
    const n = behind > FOLLOW_CATCHUP_TICS ? 2 : behind > 0 ? 1 : 0;
    for (let s = 0; s < n; s++) this.advance();
    if (this.viewers.size) this.lastViewerAt = Date.now();
    if (n) for (const v of this.viewers) v.send(this);
  }

  advance() {
    const keys = [];
    let i = 0;
    for (; i < this.events.length && this.events[i][0] <= this.engine.tic + 1; i++) {
      const [tic, key, pressed] = this.events[i];
      if (tic === this.engine.tic + 1) keys.push([key, pressed === 1]);
    }
    if (i) this.events.splice(0, i);
    this.engine.step(keys);
    const p = this.engine.paletteIfChanged();
    if (p) this.palette = Buffer.from(p);
  }

  async pollLoop() {
    while (!this.stopped) {
      await sleep(FOLLOW_POLL_MS);
      if (this.stopped) return;
      try {
        // Lease first: the owner writes a log batch and its lease tic in one
        // transaction, so after this read the log holds every input up to lease.tic.
        const lease = await store.getLease(this.id);
        if (!lease) { this.stop('game gone'); return; }
        const r = await store.readLogAfter(this.id, this.cursor);
        for (const e of r.events) this.events.push(e);
        this.cursor = r.cursor;
        this.target = Math.max(this.target, lease.tic);
      } catch (e) {
        console.error(JSON.stringify({ msg: 'follow poll failed', game: this.id, error: e.message }));
      }
    }
  }

  stop(reason, { keepViewers = false } = {}) {
    if (this.stopped) return;
    this.stopped = true;
    if (followers.get(this.id) === this) followers.delete(this.id);
    if (!keepViewers) for (const v of this.viewers) v.close();
    this.viewers.clear();
    console.log(JSON.stringify({ msg: 'follower stopped', game: this.id, reason, tic: this.engine.tic }));
  }
}

// Build a follower: replay the log to a little behind the owner, so it has a
// buffer of known input to play through.
async function follow(id) {
  const lease = await store.getLease(id);
  if (!lease) return null;
  const t0 = performance.now();
  const engine = new DoomEngine();
  const { events, cursor } = await store.readLogAfter(id, null);
  const from = Math.max(0, lease.tic - FOLLOW_BUFFER_TICS);
  const { next, palette } = await replay(engine, events, from);
  const info = { replayedTics: from, replayMs: Math.round(performance.now() - t0) };
  // The game may have moved here while we replayed: watch the real one.
  const local = games.get(id);
  if (local && !local.stopped) return local;
  const copy = new Follower(id, engine, { palette, cursor, events: events.slice(next), target: lease.tic, info });
  followers.set(id, copy);
  console.log(JSON.stringify({ msg: 'following', game: id, owner: lease.owner, ...info }));
  return copy;
}

// What a spectator watches: the game itself if it runs here, otherwise a copy.
function spectate(id) {
  const local = games.get(id);
  if (local && !local.stopped) return local;
  if (followers.has(id)) return followers.get(id);
  if (!following.has(id)) following.set(id, follow(id).finally(() => following.delete(id)));
  return following.get(id);
}

function spectatorCount() {
  let n = 0;
  for (const g of [...games.values(), ...followers.values()]) {
    for (const v of g.viewers) if (v.spectator) n++;
  }
  return n;
}

// One frame on the wire, inside a single deflate stream per connection:
//   u32 tic | u8 flags (bit 0: palette follows) | 768 bytes palette | w*h pixels XOR previous frame
// XOR against the previous frame turns unchanged pixels into zeros, which deflate
// compresses to almost nothing.
//
// The game runs at 35 tics a second but a viewer gets a frame every
// FRAME_INTERVAL_TICS tics (default 2, so 17.5 fps), on tics divisible by the
// interval, so every viewer of a game gets frames for the same tics. This cuts
// bandwidth while turning from about 805 to 472 KB/s (test/bandwidth-bench.js).
const FRAME_INTERVAL_TICS = Math.max(1, Number(process.env.FRAME_INTERVAL_TICS || 2));

class Viewer {
  constructor(res, { spectator = false } = {}) {
    this.res = res;
    this.spectator = spectator;
    this.deflate = zlib.createDeflate({ level: 6 });
    this.deflate.pipe(res);
    this.prev = null;
    this.sentPalette = null;
    this.backlogged = false;
    this.lastTic = null;
  }

  // force: send now regardless of the frame interval (a viewer's first frame,
  // and the last frame before a game stops here).
  send(game, force = false) {
    const tic = game.engine.tic;
    if (tic === this.lastTic) return;
    // A follower catching up moves two tics at a time and could skip every
    // aligned tic, hence the second test.
    if (!force && tic % FRAME_INTERVAL_TICS !== 0 && tic - (this.lastTic ?? -Infinity) < FRAME_INTERVAL_TICS) return;
    // Skip frames while the client or network is slower than the frame rate.
    if (this.backlogged) return;
    this.lastTic = tic;
    const pixels = game.engine.pixels();
    if (!this.prev) this.prev = new Uint8Array(pixels.length);
    const withPalette = game.palette && game.palette !== this.sentPalette;
    const header = Buffer.alloc(5);
    header.writeUInt32LE(game.engine.tic, 0);
    header[4] = withPalette ? 1 : 0;
    const delta = Buffer.allocUnsafe(pixels.length);
    for (let i = 0; i < pixels.length; i++) delta[i] = pixels[i] ^ this.prev[i];
    this.prev.set(pixels);
    this.deflate.write(header);
    if (withPalette) {
      this.deflate.write(game.palette);
      this.sentPalette = game.palette;
    }
    const ok = this.deflate.write(delta);
    this.deflate.flush(zlib.constants.Z_SYNC_FLUSH);
    if (!ok) {
      this.backlogged = true;
      this.deflate.once('drain', () => { this.backlogged = false; });
    }
  }

  close() {
    this.deflate.end();
  }
}

// One loop steps every game this environment owns at 35 tics per second,
// catching up if the event loop fell behind (capped so a stall doesn't
// fast-forward the game).
let nextTicAt = performance.now();
function loop() {
  const now = performance.now();
  let steps = 0;
  while (nextTicAt <= now && steps < 5) {
    for (const game of games.values()) game.step();
    for (const copy of followers.values()) copy.step();
    nextTicAt += 1000 / TICRATE;
    steps++;
  }
  if (nextTicAt < now) nextTicAt = now;
  for (const game of games.values()) {
    if (!game.hasPlayer() && Date.now() - game.lastViewerAt > IDLE_MS) game.release('idle');
  }
  for (const copy of followers.values()) {
    if (!copy.viewers.size && Date.now() - copy.lastViewerAt > FOLLOWER_IDLE_MS) copy.stop('idle');
  }
  setTimeout(loop, Math.max(0, nextTicAt - performance.now()));
}
loop();

function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/client.js': ['client.js', 'text/javascript; charset=utf-8'],
  '/qrcode.mjs': ['qrcode.mjs', 'text/javascript; charset=utf-8'], // qrcode-generator 2.0.4, MIT
};

const GAME_ROUTE = /^\/api\/games\/([0-9a-f-]{36})\/(stream|input)$/;
const WATCH_ROUTE = /^\/api\/watch\/([0-9a-f]{32})\/stream$/;
const CID = /^[a-z0-9]{8,32}$/;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  if (req.method === 'GET' && STATIC[url.pathname]) {
    const [file, type] = STATIC[url.pathname];
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' });
    fs.createReadStream(path.join(PUBLIC, file)).pipe(res);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/ping') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({ region: process.env.AWS_REGION || 'local', environment: ENV_ID }));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/healthz') {
    return json(res, 200, { ok: true, environment: ENV_ID, games: games.size, followers: followers.size, spectators: spectatorCount() });
  }

  if (req.method === 'POST' && url.pathname === '/api/games') {
    // Nothing is stored yet: the first stream request creates the game.
    return json(res, 201, { id: crypto.randomUUID() }); // unguessable: knowing the id is what lets you play
  }

  // Spectators: /api/watch/<token>/stream. The token comes from the player's
  // watch link and can't be turned back into the game id, so it gives no control.
  const w = WATCH_ROUTE.exec(url.pathname);
  if (w && req.method === 'GET') {
    if (spectatorCount() >= MAX_SPECTATORS) return json(res, 503, { error: 'too many spectators here, try again shortly' });
    let id;
    try {
      id = await store.gameForWatch(w[1]);
    } catch (e) {
      console.error(JSON.stringify({ msg: 'watch lookup failed', error: e.message }));
      return json(res, 503, { error: 'retry' });
    }
    if (!id) return json(res, 404, { error: 'no such game' });
    {
      if (!games.has(id) && !followers.has(id) && followers.size >= MAX_FOLLOWERS) {
        return json(res, 503, { error: 'server full, try again shortly' });
      }
      let source;
      try {
        source = await spectate(id);
      } catch (e) {
        console.error(JSON.stringify({ msg: 'spectate failed', game: id, error: e.message }));
        return json(res, 503, { error: 'retry' });
      }
      if (!source) return json(res, 404, { error: 'no such game' });
      if (req.destroyed || source.stopped) return req.destroyed ? undefined : json(res, 503, { error: 'retry' });
      const copy = source instanceof Follower;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-frame-format': `doom-v1;w=${source.engine.width};h=${source.engine.height}`,
        'x-doom-environment': ENV_ID,
        'x-doom-start': copy ? `watch-copy;tics=${source.info.replayedTics};ms=${source.info.replayMs}` : 'watch-owner;tics=0;ms=0',
      });
      const viewer = new Viewer(res, { spectator: true });
      source.viewers.add(viewer);
      viewer.send(source, true);
      // The viewer may move from a copy to the real game (start()), so remove it from both.
      const done = () => {
        source.viewers.delete(viewer);
        games.get(id)?.viewers.delete(viewer);
        viewer.close();
      };
      req.on('close', done);
      res.on('error', done);
      return;
    }
  }

  const m = GAME_ROUTE.exec(url.pathname);
  if (m) {
    const id = m[1];

    if (req.method === 'GET' && m[2] === 'stream') {
      if (!games.has(id) && games.size >= MAX_GAMES) return json(res, 503, { error: 'server full, try again shortly' });
      let game;
      try {
        game = await acquireOnce(id);
      } catch (e) {
        console.error(JSON.stringify({ msg: 'acquire failed', game: id, error: e.message }));
        return json(res, 503, { error: 'game busy, retry' });
      }
      if (req.destroyed) return;
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'cache-control': 'no-store',
        'x-frame-format': `doom-v1;w=${game.engine.width};h=${game.engine.height}`,
        'x-doom-environment': ENV_ID,
        'x-doom-start': `${game.info.handoff};tics=${game.info.replayedTics};ms=${game.info.replayMs}`,
      });
      const viewer = new Viewer(res);
      game.viewers.add(viewer);
      viewer.send(game, true); // current frame straight away (after a rebuild: the frame the last owner showed)
      const done = () => { game.viewers.delete(viewer); viewer.close(); };
      req.on('close', done);
      res.on('error', done);
      return;
    }

    if (req.method === 'POST' && m[2] === 'input') {
      let body;
      try {
        body = JSON.parse(await readBody(req, MAX_INPUT_BYTES));
      } catch {
        return json(res, 400, { error: 'expected JSON { cid, seq, keys: [[key, pressed], ...] }' });
      }
      const { cid, seq } = body ?? {};
      if (typeof cid !== 'string' || !CID.test(cid) || !Number.isInteger(seq) || seq < 1 || seq > 1e9) {
        return json(res, 400, { error: 'cid must be 8-32 lowercase letters or digits, seq a positive integer' });
      }
      const keys = (Array.isArray(body.keys) ? body.keys.slice(0, 32) : [])
        .filter((k) => Array.isArray(k) && isDoomKey(k[0]))
        .map((k) => [k[0], Boolean(k[1])]);
      const local = games.get(id);
      try {
        if (local) local.offer(cid, seq, keys);
        else await store.putInbox(id, cid, seq, keys);
      } catch (e) {
        console.error(JSON.stringify({ msg: 'input failed', game: id, error: e.message }));
        return json(res, 503, { error: 'retry' });
      }
      res.writeHead(204).end();
      return;
    }
  }

  json(res, 404, { error: 'not found' });
});

server.listen(Number(PORT), HOST, () => console.log(`freedoom-lambda-web-functions environment ${ENV_ID} listening on http://${HOST}:${PORT}`));

// Lambda sends SIGTERM before discarding an environment: hand games back so
// the next environment can take them over without waiting.
process.on('SIGTERM', async () => {
  server.close();
  await Promise.race([Promise.all([...games.values()].map((g) => g.release('shutdown'))), sleep(1500)]);
  process.exit(0);
});
