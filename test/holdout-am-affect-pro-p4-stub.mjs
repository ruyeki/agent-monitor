// Stand-in for `claude` for the #2289 piece 4 holdouts (not a test). Never talks to Anthropic. Fake logins only.
//   AM_LOGIN_LOG  file that gets one JSON line per call (and one {code} line when a sign-in code arrives on stdin)
//   AM_P4_STUB    JSON {url, needsCode, expectCode, oauth, email, hang, delayMs, rateLimit, failUuid}
// `auth login`: prints the sign-in URL, optionally asks for a pasted code, then writes <CLAUDE_CONFIG_DIR>/.credentials.json.
// anything else (a refresh / reading turn): rotates the tokens only when the saved login was forced to expire (expiresAt 0),
// like the real CLI; a login whose refresh token contains failUuid exits 1 without rotating.
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(process.env.AM_P4_STUB || '{}');
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? null;
const file = dir ? path.join(dir, '.credentials.json') : null;
const login = argv[0] === 'auth' && argv[1] === 'login';
let seen = null;
try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth ?? null; } catch { /* none */ }
const log = (o) => { if (process.env.AM_LOGIN_LOG) fs.appendFileSync(process.env.AM_LOGIN_LOG, `${JSON.stringify(o)}\n`); };
log({
  argv, cwd: process.cwd(), configDir: dir, pid: process.pid, login,
  hasEnvTokens: ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'].some((k) => k in process.env),
  seenExpiresAt: seen?.expiresAt ?? null, seenRefresh: seen?.refreshToken ?? null,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (login) {
  if (cfg.url) process.stdout.write(`Opening browser to sign in...\nIf the browser did not open, visit: ${cfg.url}\n`);
  if (cfg.hang && !cfg.needsCode) { setInterval(() => {}, 1000); }
  else {
    if (cfg.needsCode) {
      process.stdout.write('Paste code here if prompted > ');
      let buf = '';
      process.stdin.setEncoding('utf8');
      await new Promise((resolve) => {
        process.stdin.on('data', (c) => { buf += c; if (buf.includes('\n')) resolve(); });
        process.stdin.on('end', resolve);
      });
      const code = buf.split('\n')[0].replace(/\r$/, '');
      log({ code });
      if (code !== cfg.expectCode) process.exit(1);
    }
    if (cfg.delayMs) await sleep(cfg.delayMs);
    if (file) {
      fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: cfg.oauth }));
      if (cfg.email) fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: cfg.email } }));
    }
    process.exit(0);
  }
} else {
  if (cfg.delayMs) await sleep(cfg.delayMs);
  if (cfg.rateLimit) process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: cfg.rateLimit, session_id: 's' })}\n`);
  const fail = cfg.failUuid && seen?.refreshToken?.includes(cfg.failUuid);
  if (!fail && file && seen && seen.expiresAt === 0) {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...seen, accessToken: `${seen.accessToken}-rotated`, refreshToken: `${seen.refreshToken}-rotated`, expiresAt: Date.now() + 8 * 3600_000 } }));
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: fail ? 'error_during_execution' : 'success', is_error: Boolean(fail), result: 'OK' })}\n`);
  if (cfg.hang) setInterval(() => {}, 1000);
  else process.exit(fail ? 1 : 0);
}
