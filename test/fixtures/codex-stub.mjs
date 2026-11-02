// Stand-in for `codex`. Never talks to a model. Driven by env:
//   AM_STUB_LOG    file that gets one JSON line per call: {argv, cwd, stdin}
//   AM_STUB_CALLS  JSON array, one entry per call (the last one repeats): {lines: [object|string], exit, sleep, hold}
//   AM_STUB_RELEASE  with `hold: true`, the stub waits (after printing) until this file exists (gives up after 20 s, exit 1),
//                    then exits with its scripted code and writes <file>.done just before exiting
import fs from 'node:fs';

let stdin = '';
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) stdin += c;

const log = process.env.AM_STUB_LOG;
let n = 0;
if (log) {
  try { n = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length; } catch { /* first call */ }
  fs.appendFileSync(log, `${JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), stdin })}\n`);
}
const calls = JSON.parse(process.env.AM_STUB_CALLS || '[]');
const call = calls[Math.min(n, calls.length - 1)] ?? {};
for (const l of call.lines ?? []) process.stdout.write(`${typeof l === 'string' ? l : JSON.stringify(l)}\n`);
const done = () => process.exit(call.exit ?? 0);
if (call.hold) {
  const release = process.env.AM_STUB_RELEASE;
  const end = Date.now() + 20000;
  while (!fs.existsSync(release)) {
    if (Date.now() > end) process.exit(1);
    await new Promise((r) => setTimeout(r, 50));
  }
  fs.writeFileSync(`${release}.done`, '');
  done();
} else if (call.sleep) setTimeout(done, call.sleep); else done();
