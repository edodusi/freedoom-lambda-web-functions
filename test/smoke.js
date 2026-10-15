// Smoke test: boot the engine, start a new game through the menu, walk forward,
// and write a PNG of the last frame. Also reports the CPU cost per tic.
// Usage: node test/smoke.js [out.png]

import fs from 'node:fs';
import zlib from 'node:zlib';
import { DoomEngine, KEYS, TICRATE } from '../server/engine.js';

const out = process.argv[2] || 'smoke.png';

const t0 = performance.now();
const game = new DoomEngine();
const bootMs = performance.now() - t0;

let palette = null;
const run = (tics, keys = []) => {
  for (let i = 0; i < tics; i++) {
    game.step(i === 0 ? keys : []);
    const p = game.paletteIfChanged();
    if (p) palette = Uint8Array.from(p);
  }
};
const tap = (code) => { run(1, [[KEYS[code], true]]); run(4, []); run(1, [[KEYS[code], false]]); run(8); };

run(TICRATE); // title screen
tap('Escape'); // open menu
tap('Enter'); // New Game
tap('Enter'); // first episode
tap('Enter'); // default skill
run(TICRATE * 2); // level wipe

const t1 = performance.now();
run(1, [[KEYS.ArrowUp, true]]);
run(TICRATE * 3 - 1); // walk forward for 3 s of game time
const perTicMs = (performance.now() - t1) / (TICRATE * 3);

fs.writeFileSync(out, png(game.width, game.height, Uint8Array.from(game.pixels()), palette));
console.log(JSON.stringify({ bootMs: Math.round(bootMs), tic: game.tic, perTicMs: +perTicMs.toFixed(3), out }));

function png(w, h, pixels, pal) {
  const crc = (buf) => {
    let c = ~0;
    for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const td = Buffer.concat([Buffer.from(type), data]);
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 3; // 8-bit indexed
  const raw = Buffer.alloc((w + 1) * h);
  for (let y = 0; y < h; y++) raw.set(pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('PLTE', Buffer.from(pal)), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0)),
  ]);
}
