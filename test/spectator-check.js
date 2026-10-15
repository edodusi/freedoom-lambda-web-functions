// Spectator check: a spectator sees the player's game, frame for frame, without
// taking it over.
//
//   node test/spectator-check.js                   one local server, in-memory store:
//                                                  the spectator watches the owner's frames
//   TABLE_NAME=... node test/spectator-check.js    two local servers on one table: the
//                                                  spectator's server runs a copy that
//                                                  follows the owner's input log
//
// Plays a few seconds of input on server A, watches from B (or A), then
// compares the spectator's frames with the player's frames at the same tics.
// Passes if every compared frame is identical, the player's stream stayed on A,
// and a watch token gives no way to send input.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchToken } from '../server/store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const PIXELS = 320 * 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const remote = process.env.BASE_URL; // test a deployed endpoint instead of local servers
const shared = Boolean(process.env.TABLE_NAME) && !remote;

function server(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.lines = [];
  child.stdout.on('data', (d) => child.lines.push(...String(d).split('\n').filter((l) => l.startsWith('{'))));
  child.stderr.on('data', (d) => process.stderr.write(d));
  return child;
}

// Reads a frame stream and keeps a hash of each decoded frame by tic.
function watch(url) {
  const s = { hashes: new Map(), lastTic: null, ended: false, headers: null };
  const req = (url.startsWith('https:') ? https : http).get(url, { agent: false }, (res) => {
    s.status = res.statusCode;
    s.headers = { env: res.headers['x-doom-environment'], start: res.headers['x-doom-start'] };
    const frame = new Uint8Array(PIXELS);
    let buf = Buffer.alloc(0);
    const inflate = res.pipe(zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
    inflate.on('error', () => {});
    res.on('error', () => {});
    res.on('end', () => { s.ended = true; });
    inflate.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 5) break;
        const size = 5 + ((buf[4] & 1) ? 768 : 0) + PIXELS;
        if (buf.length < size) break;
        const delta = buf.subarray(size - PIXELS, size);
        for (let i = 0; i < PIXELS; i++) frame[i] ^= delta[i];
        s.lastTic = buf.readUInt32LE(0);
        s.hashes.set(s.lastTic, crypto.createHash('sha1').update(frame).digest('hex'));
        buf = buf.subarray(size);
      }
    });
  });
  req.on('error', () => { s.ended = true; });
  s.stop = () => req.destroy();
  return s;
}

const A = remote ? { lines: [], kill() {} } : server(3093);
const B = shared ? server(3094) : A;
const a = remote || 'http://127.0.0.1:3093';
const b = remote || (shared ? 'http://127.0.0.1:3094' : a);
if (!remote) await sleep(1500);

let failed = false;
try {
  const { id } = await (await fetch(`${a}/api/games`, { method: 'POST' })).json();
  const token = watchToken(id);
  const player = watch(`${a}/api/games/${id}/stream`);
  await sleep(500);

  // Start a game from the title screen and wander about: Esc (menu), Enter x3
  // (new game, episode, skill), then turn and walk.
  const cid = 'spect' + crypto.randomBytes(4).toString('hex');
  let seq = 0;
  const send = (keys) => fetch(`${a}/api/games/${id}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid, seq: ++seq, keys }),
  });
  for (const k of [27, 13, 13, 13]) {
    await send([[k, true]]); await sleep(150); await send([[k, false]]); await sleep(300);
  }
  await send([[0xad, true], [0xae, true]]);
  await sleep(1500);

  const spectator = watch(`${b}/api/watch/${token}/stream`);
  await sleep(1500);
  await send([[0xae, false], [0xac, true]]); // turn the other way while watched
  await sleep(2000);
  await send([[0xad, false], [0xac, false]]);
  await sleep(2500);

  // A watch token must not open the player's routes.
  const asPlayer = await fetch(`${b}/api/games/${token}/input`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid, seq: 999, keys: [[13, true]] }),
  });

  let compared = 0, mismatched = 0;
  for (const [tic, hash] of spectator.hashes) {
    if (!player.hashes.has(tic)) continue;
    compared++;
    if (player.hashes.get(tic) !== hash) mismatched++;
  }
  const result = {
    game: id,
    player: player.headers,
    spectator: spectator.headers,
    spectatorFrames: spectator.hashes.size,
    compared,
    mismatched,
    lagTics: player.lastTic - spectator.lastTic,
    playerStreamEnded: player.ended,
    tokenAsPlayerStatus: asPlayer.status,
    bLog: B.lines.filter((l) => l.includes(id)),
  };
  player.stop();
  spectator.stop();
  console.log(JSON.stringify(result, null, 1));

  const expected = remote ? 'watch-' : shared ? 'watch-copy' : 'watch-owner';
  failed = !(spectator.status === 200
    && spectator.headers.start?.startsWith(expected)
    && compared >= 50 && mismatched === 0
    && !player.ended
    && asPlayer.status === 404);
  console.log(failed ? 'FAIL' : 'PASS');
} finally {
  A.kill('SIGTERM');
  if (shared) B.kill('SIGTERM');
}
process.exitCode = failed ? 1 : 0;
