// Stand-in for `codex`. argv: <stubDir> <codex args...>. Logs each call, then plays script.json[call n].
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
const dir = process.argv[2];
const argv = process.argv.slice(3);
let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;
const logFile = path.join(dir, 'calls.jsonl');
let n = 1;
try { n = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).length + 1; } catch { /* first */ }
fs.appendFileSync(logFile, JSON.stringify({ n, argv, stdin, cwd: process.cwd(), pid: process.pid }) + '\n');
const script = JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8'));
const step = script.calls?.[n - 1] ?? script.default ?? {};
for (const e of step.events ?? []) {
  process.stdout.write((typeof e === 'string' ? e : JSON.stringify(e)) + '\n');
  if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
}
if (step.hang) {
  fs.writeFileSync(path.join(dir, `pid-${n}`), String(process.pid));
  if (step.grandchild) {
    const g = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(dir, `gpid-${n}`), String(g.pid));
  }
  setInterval(() => {}, 1000);
} else {
  if (step.sleepMs) await new Promise((r) => setTimeout(r, step.sleepMs));
  process.exitCode = step.exit ?? 0;
}
