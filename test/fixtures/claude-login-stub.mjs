// Stand-in for `claude` in the accounts tests. Never talks to Anthropic. Driven by env:
//   AM_LOGIN_LOG   file that gets one JSON line per call: {argv, cwd, configDir, hasOauthToken, hasApiKey, stdin, seen}
//                  (seen = the claudeAiOauth found in CLAUDE_CONFIG_DIR at start, fake test tokens only)
//   AM_LOGIN_STUB  JSON {exit, write, oauth, email, rateLimit, hang}
//     `auth login ...`: write 'none' writes nothing, else <dir>/.credentials.json = {claudeAiOauth: oauth} (+ .claude.json email)
//     otherwise (refresh): prints a rate_limit_event when rateLimit is set; write 'rotate' (default) rotates the tokens,
//     'other' also changes accountUuid, 'none' leaves the file; hang keeps running until killed
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(process.env.AM_LOGIN_STUB || '{}');
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, '.credentials.json') : null;
const login = argv[0] === 'auth' && argv[1] === 'login';
let seen = null;
try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth ?? null; } catch { /* none */ }
let stdin = '';
if (!login) { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) stdin += c; }
if (process.env.AM_LOGIN_LOG) {
  fs.appendFileSync(process.env.AM_LOGIN_LOG, `${JSON.stringify({
    argv, cwd: process.cwd(), configDir: dir ?? null, hasOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env, hasAuthToken: 'ANTHROPIC_AUTH_TOKEN' in process.env,
    hasApiKey: 'ANTHROPIC_API_KEY' in process.env, stdin, seen,
  })}\n`);
}
const write = cfg.write ?? (login ? 'login' : 'rotate');
if (login) {
  if (write !== 'none' && file) {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: cfg.oauth }));
    if (cfg.email) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: cfg.email } }));
  }
} else {
  if (cfg.rateLimit) process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: cfg.rateLimit, session_id: 's' })}\n`);
  if ((write === 'rotate' || write === 'other') && file && seen) {
    const next = { ...seen, accessToken: `${seen.accessToken}-rotated`, refreshToken: `${seen.refreshToken}-rotated`, expiresAt: Date.now() + 8 * 3600_000 };
    if (write === 'other') next.accountUuid = 'someone-else';
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: next }));
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: cfg.exit ? 'error_during_execution' : 'success', is_error: Boolean(cfg.exit), result: 'OK' })}\n`);
}
if (cfg.hang) setInterval(() => {}, 1000);
else process.exitCode = cfg.exit ?? 0;
