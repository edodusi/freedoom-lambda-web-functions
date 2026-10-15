// Fetches the third-party inputs into vendor/ and server/wad/:
//   - doomgeneric (GPL-2.0) at a pinned commit, the engine source
//   - Freedoom 0.13.0 (BSD-3-Clause), the game data, checked against its SHA-256
// Needs git and unzip on PATH. Then run `npm run build` to compile server/doom.wasm.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const VENDOR = path.join(ROOT, 'vendor');
const WAD_DIR = path.join(ROOT, 'server', 'wad');

const DOOMGENERIC = { repo: 'https://github.com/ozkl/doomgeneric.git', commit: 'e257a09527062bfb986b6e5e0780839b6cbd5b71' };
const FREEDOOM = {
  url: 'https://github.com/freedoom/freedoom/releases/download/v0.13.0/freedoom-0.13.0.zip',
  sha256: '3f9b264f3e3ce503b4fb7f6bdcb1f419d93c7b546f4df3e874dd878db9688f59',
};

fs.mkdirSync(VENDOR, { recursive: true });
fs.mkdirSync(WAD_DIR, { recursive: true });

const dg = path.join(VENDOR, 'doomgeneric');
if (!fs.existsSync(dg)) {
  execFileSync('git', ['clone', DOOMGENERIC.repo, dg], { stdio: 'inherit' });
}
execFileSync('git', ['-C', dg, 'checkout', '--quiet', DOOMGENERIC.commit], { stdio: 'inherit' });
console.log(`doomgeneric at ${DOOMGENERIC.commit}`);

const zip = path.join(VENDOR, 'freedoom-0.13.0.zip');
if (!fs.existsSync(zip)) {
  const res = await fetch(FREEDOOM.url);
  if (!res.ok) throw new Error(`Freedoom download failed: ${res.status}`);
  fs.writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
}
const actual = crypto.createHash('sha256').update(fs.readFileSync(zip)).digest('hex');
if (actual !== FREEDOOM.sha256) throw new Error(`Freedoom checksum mismatch: ${actual}`);

execFileSync('unzip', ['-o', '-q', '-j', zip, 'freedoom-0.13.0/freedoom1.wad', 'freedoom-0.13.0/COPYING.txt', '-d', WAD_DIR]);
fs.renameSync(path.join(WAD_DIR, 'COPYING.txt'), path.join(WAD_DIR, 'FREEDOOM-COPYING.txt'));
console.log(`Freedoom 0.13.0 -> ${WAD_DIR}`);
