// Bandwidth bench: plays a fixed input script on the engine (no server, no
// network), records every frame, then measures how many bytes per second each
// frame encoding and compressor would put on the wire for the same frames.
//
//   node test/bandwidth-bench.js
//
// Segments: "menu" (title and menus), "turn" (turning on the spot, the worst
// case: every pixel moves), "walk" (walking and strafing). Each encoder runs as
// one stream per segment, flushed after every frame, like the server does.

import zlib from 'node:zlib';
import { DoomEngine, TICRATE } from '../server/engine.js';

const engine = new DoomEngine();
const N = engine.width * engine.height;
const frames = []; // { seg, pixels }
const seconds = (s) => Math.round(s * TICRATE);

function run(seg, tics, keysAt = {}) {
  for (let t = 0; t < tics; t++) {
    engine.step(keysAt[t] || []);
    engine.paletteIfChanged();
    if (seg) frames.push({ seg, pixels: Uint8Array.from(engine.pixels()) });
  }
}

const press = (k) => [[k, true]], release = (k) => [[k, false]];
run('menu', seconds(3), { 10: press(27), 15: release(27), 40: press(13), 45: release(13), 60: press(13), 65: release(13) });
run(null, seconds(1), { 0: press(13), 5: release(13) }); // skill select, then the level loads
run('turn', seconds(6), { 0: press(0xae) });
run('walk', seconds(6), { 0: [[0xae, false], [0xad, true], [0xa0, true]], 70: [[0xa0, false], [0xa1, true]], 140: [[0xac, true]] });

// ---- frame encodings: what goes into the compressor for each frame ----
const encodings = {
  // current: XOR with the previous frame (unchanged pixels become 0)
  xor: (cur, prev) => { const o = new Uint8Array(N); for (let i = 0; i < N; i++) o[i] = cur[i] ^ prev[i]; return o; },
  // raw pixels: lets a long-window compressor find the previous frame itself
  raw: (cur) => cur,
  // per frame, the smaller of XOR-previous-frame and XOR-pixel-above (one flag byte)
  best: (cur, prev) => {
    const a = new Uint8Array(N + 1), b = new Uint8Array(N + 1);
    let za = 0, zb = 0;
    const W = engine.width;
    for (let i = 0; i < N; i++) {
      a[i + 1] = cur[i] ^ prev[i]; if (!a[i + 1]) za++;
      b[i + 1] = i < W ? cur[i] : cur[i] ^ cur[i - W]; if (!b[i + 1]) zb++;
    }
    a[0] = 0; b[0] = 1;
    return za >= zb ? a : b;
  },
};

// ---- compressors, each a streaming instance flushed per frame ----
const Z = zlib.constants;
const compressors = {
  'deflate-6': () => zlib.createDeflate({ level: 6 }),
  'deflate-9': () => zlib.createDeflate({ level: 9, memLevel: 9 }),
  'brotli-5': () => zlib.createBrotliCompress({ params: { [Z.BROTLI_PARAM_QUALITY]: 5, [Z.BROTLI_PARAM_LGWIN]: 22 } }),
  'brotli-9': () => zlib.createBrotliCompress({ params: { [Z.BROTLI_PARAM_QUALITY]: 9, [Z.BROTLI_PARAM_LGWIN]: 22 } }),
};
if (zlib.createZstdCompress) {
  compressors['zstd-3'] = () => zlib.createZstdCompress({ params: { [Z.ZSTD_c_compressionLevel]: 3, [Z.ZSTD_c_windowLog]: 22 } });
  compressors['zstd-9'] = () => zlib.createZstdCompress({ params: { [Z.ZSTD_c_compressionLevel]: 9, [Z.ZSTD_c_windowLog]: 22 } });
}
const flushKind = (name) => (name.startsWith('brotli') ? Z.BROTLI_OPERATION_FLUSH : name.startsWith('zstd') ? Z.ZSTD_e_flush : Z.Z_SYNC_FLUSH);

async function measure(seg, encName, compName, every) {
  const segFrames = frames.filter((f) => f.seg === seg);
  const c = compressors[compName]();
  let bytes = 0;
  c.on('data', (d) => { bytes += d.length; });
  const enc = encodings[encName];
  let prev = new Uint8Array(N);
  let sent = 0;
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < segFrames.length; i += every) {
    const cur = segFrames[i].pixels;
    c.write(Buffer.alloc(5)); // frame header (tic, flags)
    c.write(enc(cur, prev));
    await new Promise((r) => c.flush(flushKind(compName), r));
    prev = cur;
    sent++;
  }
  const cpuMs = Number(process.hrtime.bigint() - t0) / 1e6;
  c.end();
  const secs = segFrames.length / TICRATE;
  return { kbps: Math.round(bytes / 1024 / secs), msPerFrame: +(cpuMs / sent).toFixed(2) };
}

const rows = [];
for (const every of [1, 2]) {
  for (const encName of Object.keys(encodings)) {
    for (const compName of Object.keys(compressors)) {
      const row = { fps: TICRATE / every, enc: encName, comp: compName };
      for (const seg of ['menu', 'turn', 'walk']) {
        const r = await measure(seg, encName, compName, every);
        row[`${seg} KB/s`] = r.kbps;
        if (seg === 'turn') row['turn ms/frame'] = r.msPerFrame;
      }
      rows.push(row);
    }
  }
}
rows.sort((x, y) => x['turn KB/s'] - y['turn KB/s']);
console.table(rows);
