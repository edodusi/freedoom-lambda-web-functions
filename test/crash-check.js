// Crash check: the owner dies without handing over. Another environment must
// take the game once the owner's heartbeat goes stale, and rebuild it from the
// log (losing at most the last unflushed half-second of input).
//
// Starts two local servers itself, sharing TABLE_NAME (required), then kills
// the first with SIGKILL so it gets no chance to flush.
//   TABLE_NAME=... node test/crash-check.js

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.TABLE_NAME) throw new Error('set TABLE_NAME (crash check needs a shared DynamoDB table)');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function server(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.lines = [];
  child.stdout.on('data', (d) => child.lines.push(...String(d).split('\n').filter((l) => l.startsWith('{'))));
  return child;
}

const A = server(3091);
const B = server(3092);
await sleep(1500);

try {
  const { id } = await (await fetch('http://127.0.0.1:3091/api/games', { method: 'POST' })).json();
  const acA = new AbortController();
  const resA = await fetch(`http://127.0.0.1:3091/api/games/${id}/stream`, { signal: acA.signal });
  const envA = resA.headers.get('x-doom-environment');
  resA.body.cancel().catch(() => {});
  await sleep(3000); // A runs the game and flushes its log for ~3 s

  A.kill('SIGKILL');
  const t0 = Date.now();
  const resB = await fetch(`http://127.0.0.1:3092/api/games/${id}/stream`);
  const waitedMs = Date.now() - t0;
  const result = {
    game: id,
    A: envA,
    B: resB.headers.get('x-doom-environment'),
    start: resB.headers.get('x-doom-start'),
    waitedMs,
    bLog: B.lines.filter((l) => l.includes(id)),
  };
  resB.body.cancel().catch(() => {});
  console.log(JSON.stringify(result, null, 1));
  const ok = resB.ok && result.start?.startsWith('takeover') && !result.start.includes('tics=0;');
  console.log(ok ? 'PASS' : 'FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  A.kill('SIGKILL');
  B.kill('SIGTERM');
}
