// Runs test/handoff-check.js against two local servers sharing TABLE_NAME,
// starting and stopping the servers itself.
//   TABLE_NAME=... node test/local-handoff.js

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.env.TABLE_NAME) throw new Error('set TABLE_NAME (handoffs need a shared DynamoDB table)');
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const server = (port) => spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(port) }, stdio: 'ignore',
});

const servers = [server(3081), server(3082)];
await sleep(1500);
const check = spawn(process.execPath, [path.join(ROOT, 'test', 'handoff-check.js'), 'http://127.0.0.1:3081', 'http://127.0.0.1:3082'], { stdio: 'inherit' });
const code = await new Promise((r) => check.on('exit', r));
for (const s of servers) s.kill('SIGTERM');
process.exitCode = code;
