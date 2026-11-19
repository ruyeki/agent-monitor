// Stand-in for claude. argv[2] = log dir. Never talks to a model; never prints token values.
// Logs {argv, cwd, stdin, env, expiresAtSeen} to <dir>/calls.jsonl.
// `auth login`: writes <CLAUDE_CONFIG_DIR>/.credentials.json for account STUB_LOGIN_ACCOUNT (default "fresh").
// otherwise (-p ...): if STUB_ROTATE=1 rotates the config dir's tokens (STUB_UUID overrides the uuid), emits stream-json.
import fs from 'node:fs';
import path from 'node:path';
let stdin = '';
if (!process.argv.includes('login')) { process.stdin.setEncoding('utf8'); for await (const c of process.stdin) stdin += c; }
const dir = process.argv[2]; const args = process.argv.slice(3);
const cfg = process.env.CLAUDE_CONFIG_DIR; const credFile = cfg ? path.join(cfg, '.credentials.json') : null;
let expiresAtSeen = null; let cur = null;
try { cur = JSON.parse(fs.readFileSync(credFile, 'utf8')); expiresAtSeen = cur.claudeAiOauth?.expiresAt ?? null; } catch { /* none */ }
fs.appendFileSync(path.join(dir, 'calls.jsonl'), `${JSON.stringify({ argv: args, cwd: process.cwd(), stdin, env: { CLAUDE_CONFIG_DIR: cfg, hasOauthEnv: 'CLAUDE_CODE_OAUTH_TOKEN' in process.env, hasApiKey: 'ANTHROPIC_API_KEY' in process.env }, expiresAtSeen })}\n`);
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (args.includes('auth') && args.includes('login')) {
  const n = process.env.STUB_LOGIN_ACCOUNT || 'fresh';
  fs.writeFileSync(credFile, JSON.stringify({ mcpOAuth: {}, claudeAiOauth: { accessToken: `AMVTOK-at-${n}`, refreshToken: `AMVTOK-rt-${n}`, expiresAt: Date.now() + 8 * 3600e3, refreshTokenExpiresAt: Date.now() + 30 * 864e5, scopes: ['user:inference'], subscriptionType: 'team', subscriptionTypeSource: 'x', rateLimitTier: 't', accountUuid: `uuid-${n}`, organizationUuid: `org-${n}` }, organizationUuid: `org-${n}` }));
  process.exit(0);
}
if (cur && process.env.STUB_ROTATE === '1') {
  cur.claudeAiOauth.accessToken = `AMVTOK-at-rot-${Date.now()}`; cur.claudeAiOauth.refreshToken = `AMVTOK-rt-rot-${process.env.STUB_ROT_TAG || 'x'}`; cur.claudeAiOauth.expiresAt = Date.now() + 8 * 3600e3;
  if (process.env.STUB_UUID) cur.claudeAiOauth.accountUuid = process.env.STUB_UUID;
  fs.writeFileSync(credFile, JSON.stringify(cur));
}
const util = Number(process.env.STUB_UTIL ?? '0.5'); const reset = Math.floor(Date.now() / 1000) + 3 * 3600;
out({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: reset, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: util, resetsAt: reset }, seven_day: { utilization: 0.2, resetsAt: reset + 86400 } } }, session_id: 's' });
const sid = (() => { const i = args.indexOf('--resume'); return i >= 0 ? args[i + 1] : 'new-session'; })();
out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), permissionMode: 'default' });
if (process.env.STUB_HOLD) await new Promise((r) => setTimeout(r, Number(process.env.STUB_HOLD)));
out({ type: 'result', subtype: 'success', is_error: false, api_error_status: null, result: 'ok', session_id: sid });
process.exit(0);
