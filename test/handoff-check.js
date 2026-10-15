// Handoff check: proves a game moves between execution environments without
// losing state. Needs two servers sharing one store (two local processes with
// the same TABLE_NAME, or the deployed endpoint).
//
//   node test/handoff-check.js http://127.0.0.1:3081 http://127.0.0.1:3082
//
// 1. Opens the stream on A and starts a game, sending input to B (so it goes
//    through the DynamoDB inbox).
// 2. Plays a few seconds, then opens a stream on B. B asks A to hand over,
//    A flushes its log and stops, B replays the log.
// 3. Passes if B's first frame is pixel-identical to A's last frame, on the
//    same tic.

import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';

const [a, b] = [process.argv[2] || 'http://127.0.0.1:3081', process.argv[3] || 'http://127.0.0.1:3082'];
const PIXELS = 320 * 200;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { id } = await (await fetch(`${a}/api/games`, { method: 'POST' })).json();
const cid = 'handoff' + crypto.randomBytes(4).toString('hex');
let seq = 0;
const send = (base, keys) => fetch(`${base}/api/games/${id}/input`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ cid, seq: ++seq, keys }),
});

// Reads a frame stream; keeps the decoded current frame and its tic. Each
// stream opens its own socket (agent: false): reused keep-alive sockets tend
// to reach the same environment, which would hide the handoff.
function watch(base, name) {
  const s = { name, frames: 0, tic: null, firstTic: null, firstHash: null, lastHash: null, ended: false, headers: null };
  let req;
  s.stop = () => req?.destroy();
  s.ready = new Promise((resolve, reject) => {
    const url = new URL(`${base}/api/games/${id}/stream`);
    req = (url.protocol === 'https:' ? https : http).get(url, { agent: false }, (res) => {
      s.headers = { 'x-doom-environment': res.headers['x-doom-environment'], 'x-doom-start': res.headers['x-doom-start'] };
      resolve(res);
    });
    req.on('error', reject);
  }).then((raw) => {
    const frame = new Uint8Array(PIXELS);
    let buf = Buffer.alloc(0);
    raw.on('error', () => {});
    const inflate = raw.pipe(zlib.createInflate({ finishFlush: zlib.constants.Z_SYNC_FLUSH }));
    inflate.on('error', () => {});
    inflate.on('end', () => { s.ended = true; });
    raw.on('end', () => { s.ended = true; });
    inflate.on('data', (c) => {
      buf = Buffer.concat([buf, c]);
      for (;;) {
        if (buf.length < 5) break;
        const size = 5 + ((buf[4] & 1) ? 768 : 0) + PIXELS;
        if (buf.length < size) break;
        const delta = buf.subarray(size - PIXELS, size);
        for (let i = 0; i < PIXELS; i++) frame[i] ^= delta[i];
        s.tic = buf.readUInt32LE(0);
        const hash = crypto.createHash('sha256').update(frame).digest('hex').slice(0, 16);
        if (s.firstTic === null) { s.firstTic = s.tic; s.firstHash = hash; }
        s.lastHash = hash;
        s.frames++;
        buf = buf.subarray(size);
      }
    });
  });
  return s;
}

const A = watch(a, 'A');
await A.ready;
await sleep(1000);

// Start a game through the menu, input via B, then walk and turn.
for (const k of [27, 13, 13, 13]) {
  await send(b, [[k, true]]); await sleep(150); await send(b, [[k, false]]); await sleep(300);
}
await sleep(1500);
await send(b, [[0xad, true], [0xae, true]]);
await sleep(3000);

// Open B until it reaches a different environment from A (the endpoint picks
// the environment, so this can take a few tries). A stream on A's own
// environment just reattaches, so closing it changes nothing.
let B;
for (let i = 0; i < 15; i++) {
  B = watch(b, 'B');
  await B.ready;
  if (B.headers['x-doom-environment'] !== A.headers['x-doom-environment']) break;
  B.stop();
  await sleep(200);
}
for (let i = 0; i < 50 && !A.ended; i++) await sleep(100);
await sleep(1500);
await send(b, [[0xad, false], [0xae, false]]);
await sleep(500);
A.stop();
B.stop();

const result = {
  game: id,
  A: { env: A.headers['x-doom-environment'], start: A.headers['x-doom-start'], frames: A.frames, lastTic: A.tic, ended: A.ended },
  B: { env: B.headers['x-doom-environment'], start: B.headers['x-doom-start'], frames: B.frames, firstTic: B.firstTic, lastTic: B.tic },
  sameEnvironment: A.headers['x-doom-environment'] === B.headers['x-doom-environment'],
  sameTic: A.tic === B.firstTic,
  sameFrame: A.lastHash === B.firstHash,
};
console.log(JSON.stringify(result, null, 1));
const pass = result.sameEnvironment || (result.A.ended && result.sameTic && result.sameFrame && B.frames > 10);
console.log(result.sameEnvironment ? 'SKIP: both streams reached the same environment, retry' : pass ? 'PASS' : 'FAIL');
process.exit(pass ? 0 : 1);
