// Determinism check: two separate engine instances fed the same key events at
// the same tics must end on the same frame. Milestone 2 depends on this, because
// a different execution environment rebuilds a game by replaying its inputs.
// Usage: node test/determinism.js

import crypto from 'node:crypto';
import { DoomEngine, KEYS, TICRATE } from '../server/engine.js';

// [tic, code, pressed]: start a game, then walk, turn, fire and run.
const script = [
  [35, 'Escape', true], [40, 'Escape', false],
  [50, 'Enter', true], [55, 'Enter', false],
  [65, 'Enter', true], [70, 'Enter', false],
  [80, 'Enter', true], [85, 'Enter', false],
  [160, 'ArrowUp', true], [200, 'ArrowRight', true], [230, 'ArrowRight', false],
  [240, 'ControlLeft', true], [300, 'ControlLeft', false], [310, 'ShiftLeft', true],
  [400, 'ArrowLeft', true], [450, 'ArrowLeft', false], [500, 'ArrowUp', false],
];
const END = TICRATE * 20;

function play() {
  const game = new DoomEngine();
  let i = 0;
  while (game.tic < END) {
    const keys = [];
    while (i < script.length && script[i][0] === game.tic + 1) {
      keys.push([KEYS[script[i][1]], script[i][2]]);
      i++;
    }
    game.step(keys);
  }
  return crypto.createHash('sha256').update(game.pixels()).digest('hex');
}

const t0 = performance.now();
const a = play();
const replayMs = performance.now() - t0;
const b = play();
console.log(JSON.stringify({ tics: END, same: a === b, replayMsFor20s: Math.round(replayMs), a: a.slice(0, 12), b: b.slice(0, 12) }));
process.exit(a === b ? 0 : 1);
