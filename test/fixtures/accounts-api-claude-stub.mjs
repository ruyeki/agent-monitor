// Stand-in for `claude` in the Accounts API tests. Never talks to Anthropic; fake tokens and codes only. Driven by env:
//   AM_API_LOG   file that gets one JSON line per call {argv, cwd, configDir, pid, hasOauthToken, hasApiKey, hasAuthToken, stdin,
//                seenExpiresAt}, plus one {code} line per code line `auth login` reads
//   AM_API_STUB  JSON {login, hostile, hostileOnly, split, invalidDelay, uuid, email, good, rateLimit, noEvent, hold}
// `auth login ...` prints what Claude Code 2.1.301 printed with piped stdio (probed on percy), then by login mode:
//   'code' (default): reads code lines; no '#' -> "Invalid code..." on stderr (after invalidDelay ms) and waits again; good (default 'good#stubstate') ->
//     writes the login (2.1.287 shape: tokens without accountUuid, oauthAccount in .claude.json) and exits 0; another -> exit 1
//   'auto': writes the login after 200 ms with no code (the browser's localhost redirect); 'fail': exit 1; 'hang': waits forever
// otherwise (-p): reads the prompt from stdin, refreshes the login only when it has expired (as Claude Code does), prints a
//   rate_limit_event (unless noEvent) and a result; hold delays the exit by that many ms
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const cfg = JSON.parse(process.env.AM_API_STUB || '{}');
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR ?? null;
const file = dir ? path.join(dir, '.credentials.json') : null;
const login = argv[0] === 'auth' && argv[1] === 'login';
const log = (o) => { if (process.env.AM_API_LOG) fs.appendFileSync(process.env.AM_API_LOG, `${JSON.stringify(o)}\n`); };
let seen = null;
try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth ?? null; } catch { /* none */ }
let stdin = '';
if (!login) { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) stdin += c; }
log({
  argv, cwd: process.cwd(), configDir: dir, pid: process.pid, hasOauthToken: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env,
  hasApiKey: 'ANTHROPIC_API_KEY' in process.env, hasAuthToken: 'ANTHROPIC_AUTH_TOKEN' in process.env, stdin, seenExpiresAt: seen?.expiresAt ?? null,
});
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const URL_OK = 'https://claude.com/cai/oauth/authorize?code=true&client_id=stub-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=stub&code_challenge_method=S256&state=stubstate';
const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
const DEFAULT_INFO = { status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.5, resetsAt: reset }, seven_day: { utilization: 0.2, resetsAt: reset + 86400 } } };
const HOSTILE = ['https://evil.example.com/cai/oauth/authorize?next=https://claude.com/', 'https://claude.com.evil.example/login',
  'http://claude.com/plain-http', 'https://user:pw@claude.ai/with-credentials', 'https://claude.ai:8443/with-port'];

function writeLogin() {
  const u = cfg.uuid ?? 'uuid-new';
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: {
    accessToken: `sk-ant-oat01-FAKE-api-${u}-access`, refreshToken: `sk-ant-ort01-FAKE-api-${u}-refresh`, expiresAt: Date.now() + 8 * 3600e3,
    refreshTokenExpiresAt: Date.now() + 30 * 86400e3, scopes: ['user:inference'], subscriptionType: 'team', rateLimitTier: 'default', clientId: 'cid',
  } }));
  fs.writeFileSync(path.join(dir, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: u, emailAddress: cfg.email ?? 'new@example.com', organizationUuid: `org-${u}` } }));
}

if (login) {
  process.stdout.write('Opening browser to sign in…\n');
  if (cfg.hostile || cfg.hostileOnly) process.stdout.write(HOSTILE.map((u) => `Or visit: ${u}\n`).join(''));
  if (!cfg.hostileOnly) {
    if (cfg.split) { process.stdout.write(`If the browser didn't open, visit: ${URL_OK.slice(0, 40)}`); await sleep(150); process.stdout.write(`${URL_OK.slice(40)}\n`); }
    else process.stdout.write(`If the browser didn't open, visit: ${URL_OK}\n`);
  }
  process.stdout.write('Paste code here if prompted > ');
  const mode = cfg.login ?? 'code';
  if (mode === 'auto') { await sleep(200); writeLogin(); process.stdout.write('Login successful.\n'); process.exit(0); }
  if (mode === 'fail') { await sleep(100); process.stderr.write('Login failed: something went wrong\n'); process.exit(1); }
  if (mode === 'hang') setInterval(() => {}, 1000);
  else {
    for await (const line of readline.createInterface({ input: process.stdin })) {
      log({ code: line });
      if (!line.includes('#')) { await sleep(cfg.invalidDelay ?? 0); process.stderr.write('Invalid code. Please make sure the full code was copied.\n'); continue; }
      if (line === (cfg.good ?? 'good#stubstate')) { writeLogin(); process.stdout.write('Login successful.\n'); process.exit(0); }
      process.stderr.write('Login failed: Request failed with status code 400\n');
      process.exit(1);
    }
  }
} else {
  if (seen && !(Number(seen.expiresAt) > Date.now())) {
    fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: { ...seen, accessToken: `${seen.accessToken}-rotated`, refreshToken: `${seen.refreshToken}-rotated`, expiresAt: Date.now() + 8 * 3600e3 } }));
  }
  if (!cfg.noEvent) process.stdout.write(`${JSON.stringify({ type: 'rate_limit_event', rate_limit_info: cfg.rateLimit ?? DEFAULT_INFO, session_id: 's' })}\n`);
  if (cfg.hold) await sleep(cfg.hold);
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: cfg.noEvent ? 'error_during_execution' : 'success', is_error: Boolean(cfg.noEvent), result: 'OK' })}\n`);
  process.exitCode = cfg.noEvent ? 1 : 0;
}
