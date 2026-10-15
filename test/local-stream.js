// Starts one local server, runs test/stream-check.js against it, stops it.
//   node test/local-stream.js [seconds]
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const srv = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env: { ...process.env, PORT: '3095' }, stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const check = spawn(process.execPath, [path.join(ROOT, 'test', 'stream-check.js'), 'http://127.0.0.1:3095', process.argv[2] || '5'], { stdio: 'inherit' });
process.exitCode = await new Promise((r) => check.on('exit', r));
srv.kill('SIGTERM');
