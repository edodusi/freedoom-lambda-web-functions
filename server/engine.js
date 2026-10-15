// Runs one Doom game inside a WebAssembly instance.
//
// The WASM module is compiled once per process. Each game gets its own instance,
// so its own linear memory: games in the same execution environment share
// nothing. The host drives time, so step() advances the game exactly one tic
// (1/35 s of game time) and the same inputs always give the same game.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WASI } from 'node:wasi';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WAD_DIR = path.join(HERE, 'wad');
export const TICRATE = 35;

const wasmModule = await WebAssembly.compile(fs.readFileSync(path.join(HERE, 'doom.wasm')));

// Doom writes default.cfg and savegames to $HOME. Give it a throwaway folder
// per process under the OS temp dir (/tmp on Lambda), or DOOM_DATA_DIR if set.
const DATA_ROOT = process.env.DOOM_DATA_DIR || os.tmpdir();
fs.mkdirSync(DATA_ROOT, { recursive: true });
const DATA_DIR = fs.mkdtempSync(path.join(DATA_ROOT, 'doom-'));

// Doom key codes from doomgeneric/doomkeys.h, keyed by browser KeyboardEvent.code.
export const KEYS = {
  ArrowUp: 0xad, ArrowDown: 0xaf, ArrowLeft: 0xac, ArrowRight: 0xae,
  KeyW: 0xad, KeyS: 0xaf, KeyA: 0xa0, KeyD: 0xa1, // WASD: A/D strafe
  ControlLeft: 0xa3, ControlRight: 0xa3, // fire
  Space: 0xa2, KeyE: 0xa2, // use
  ShiftLeft: 0x80 + 0x36, ShiftRight: 0x80 + 0x36, // run
  AltLeft: 0x80 + 0x38, AltRight: 0x80 + 0x38, // strafe modifier
  Enter: 13, Escape: 27, Tab: 9, Backspace: 0x7f,
  KeyY: 'y'.charCodeAt(0), KeyN: 'n'.charCodeAt(0),
  Digit1: 49, Digit2: 50, Digit3: 51, Digit4: 52, Digit5: 53, Digit6: 54, Digit7: 55,
  Minus: 0x2d, Equal: 0x3d,
};
const VALID_KEYS = new Set(Object.values(KEYS));
export const isDoomKey = (k) => VALID_KEYS.has(k);

export class DoomEngine {
  constructor() {
    this.wasi = new WASI({
      version: 'preview1',
      args: ['doom'],
      env: { HOME: '/data' },
      preopens: { '/wad': WAD_DIR, '/data': DATA_DIR },
      returnOnExit: true,
    });
    this.instance = new WebAssembly.Instance(wasmModule, this.wasi.getImportObject());
    this.wasi.initialize(this.instance);
    this.x = this.instance.exports;
    this.tic = 0;
    this.x.dg_start();
    this.width = this.x.dg_width();
    this.height = this.x.dg_height();
  }

  // keys: array of [doomKey, pressed]. Unknown key codes are ignored.
  step(keys = []) {
    for (const [key, pressed] of keys) {
      if (VALID_KEYS.has(key)) this.x.dg_push_key(pressed ? 1 : 0, key);
    }
    this.tic += 1;
    this.x.dg_set_time(1000 + Math.ceil((this.tic * 1000) / TICRATE));
    this.x.dg_tick();
  }

  // Views into WASM memory. Copy them if you keep them past the next step().
  pixels() {
    return new Uint8Array(this.x.memory.buffer, this.x.dg_screen(), this.width * this.height);
  }

  // Returns the 768-byte RGB palette if it changed since the last call, else null.
  paletteIfChanged() {
    if (!this.x.dg_palette_changed()) return null;
    return new Uint8Array(this.x.memory.buffer, this.x.dg_palette(), 768);
  }
}
