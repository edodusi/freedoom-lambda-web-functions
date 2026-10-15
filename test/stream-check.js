// End-to-end check against a running server: start a game, read the frame
// stream for a few seconds, send input, and report frames per second and
// compressed bandwidth. Usage: node test/stream-check.js [baseUrl] [seconds]

import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const base = process.argv[2] || 'http://127.0.0.1:3000';
const seconds = Number(process.argv[3] || 5);
const PIXELS = 320 * 200;

const created = await fetch(`${base}/api/games`, { method: 'POST' });
if (created.status !== 201) throw new Error(`create: ${created.status} ${await created.text()}`);
const { id } = await created.json();

const ac = new AbortController();
const res = await fetch(`${base}/api/games/${id}/stream`, { signal: ac.signal });
if (!res.ok) throw new Error(`stream: ${res.status}`);

let compressed = 0, frames = 0, palettes = 0, firstTic = null, lastTic = 0;
let buf = Buffer.alloc(0);
const raw = Readable.fromWeb(res.body);
raw.on('data', (c) => { compressed += c.length; });
raw.on('error', () => {}); // the abort at the end is expected
const inflate = raw.pipe(zlib.createInflate());
inflate.on('data', (c) => {
  buf = Buffer.concat([buf, c]);
  for (;;) {
    if (buf.length < 5) break;
    const hasPal = buf[4] & 1;
    const size = 5 + (hasPal ? 768 : 0) + PIXELS;
    if (buf.length < size) break;
    lastTic = buf.readUInt32LE(0);
    if (firstTic === null) firstTic = lastTic;
    frames++;
    palettes += hasPal;
    buf = buf.subarray(size);
  }
});
inflate.on('error', () => {});

let seq = 0;
const cid = 'streamcheck' + Math.random().toString(36).slice(2, 8);
const send = (keys) => fetch(`${base}/api/games/${id}/input`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ cid, seq: ++seq, keys }),
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Menu -> New Game -> episode -> skill, then hold forward and turn, so the
// bandwidth figure reflects gameplay rather than a still title screen.
const input = await send([[27, true]]);
await sleep(100); await send([[27, false]]);
for (let i = 0; i < 3; i++) { await sleep(300); await send([[13, true]]); await sleep(100); await send([[13, false]]); }
await sleep(1500);
const before = { frames, compressed };
await send([[0xad, true], [0xae, true]]);
await sleep(seconds * 1000);
ac.abort();
frames -= before.frames;
compressed -= before.compressed;

console.log(JSON.stringify({
  id,
  inputStatus: input.status,
  frames,
  fps: +(frames / seconds).toFixed(1),
  ticsAdvanced: lastTic - (firstTic ?? 0),
  palettes,
  kbPerSecond: +(compressed / 1024 / seconds).toFixed(1),
}));
