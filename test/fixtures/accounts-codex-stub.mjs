// Stand-in for codex. argv[2] = dir. Logs one JSON line per call, emits a thread, exits 0.
import fs from 'node:fs';
import path from 'node:path';
let stdin = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) stdin += c;
const dir = process.argv[2];
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: process.argv.slice(3), cwd: process.cwd(), stdin })}\n`);
process.stdout.write(`${JSON.stringify({ type: 'thread.started', thread_id: `T-${Date.now()}` })}\n`);
await new Promise((r) => setTimeout(r, 600));
process.exit(0);
