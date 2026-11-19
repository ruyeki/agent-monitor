// Stand-in for `claude` (refresh): rotates the fake tokens in CLAUDE_CONFIG_DIR like a real refresh, then leaves a
// detached child whose cwd is that dir for a few seconds (as a lingering helper process or a scanner would). Fake tokens only.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';

const dir = process.env.CLAUDE_CONFIG_DIR;
const file = path.join(dir, '.credentials.json');
for await (const _ of process.stdin) { /* drain the prompt */ }
const seen = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth;
fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...seen, refreshToken: `${seen.refreshToken}-rotated`, expiresAt: Date.now() + 8 * 3600_000 } }));
const ms = Number(process.env.AM_LINGER_MS || 6000);
cp.spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`], { cwd: dir, detached: true, stdio: 'ignore', windowsHide: true }).unref();
process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })}\n`);
