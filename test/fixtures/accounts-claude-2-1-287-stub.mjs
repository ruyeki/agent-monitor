// Verifier's own stand-in for claude 2.1.287. Fake tokens only. Env VH_STUB JSON.
// login: 8-field claudeAiOauth (no accountUuid) + <dir>/.claude.json oauthAccount. refresh: rebuilds the 8 fields from the seen login.
import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(process.env.VH_STUB || '{}');
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const creds = path.join(dir, '.credentials.json');
const cj = path.join(dir, '.claude.json');
const login = argv[0] === 'auth' && argv[1] === 'login';
if (process.env.VH_LOG) fs.appendFileSync(process.env.VH_LOG, `${JSON.stringify({ argv, dir })}\n`);
const FIELDS = ['accessToken', 'refreshToken', 'expiresAt', 'refreshTokenExpiresAt', 'scopes', 'subscriptionType', 'rateLimitTier', 'clientId'];
const acctJson = (a) => ({ oauthAccount: { accountUuid: a.uuid, ...(a.email === null ? {} : { emailAddress: a.email }), organizationUuid: a.org ?? `org-${a.uuid}`, organizationName: 'Org' }, numStartups: 4 });
if (login) {
  if (!cfg.noTokens) {
    const u = cfg.uuid;
    const oa = { accessToken: `sk-ant-oat01-FAKE-vh-${u}-access`, refreshToken: `sk-ant-ort01-FAKE-vh-${u}-refresh`, expiresAt: Date.now() + 8 * 3600e3, refreshTokenExpiresAt: Date.now() + 30 * 86400e3, scopes: ['user:inference'], subscriptionType: 'team', rateLimitTier: 'default', clientId: 'cid' };
    if (cfg.credsUuid) oa.accountUuid = cfg.credsUuid;
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: oa }));
    if (!cfg.noOauthAccount) fs.writeFileSync(cj, JSON.stringify(acctJson({ uuid: u, email: cfg.email, org: cfg.org })));
  }
} else {
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(creds, 'utf8')).claudeAiOauth; } catch { /* none */ }
  process.stdin.setEncoding('utf8');
  for await (const c of process.stdin) void c;
  if (seen && cfg.write !== 'none') {
    const next = {};
    for (const k of FIELDS) if (k in seen) next[k] = seen[k];
    next.accessToken = `${seen.accessToken}-r`; next.refreshToken = `${seen.refreshToken}-r`; next.expiresAt = Date.now() + 8 * 3600e3;
    if (cfg.credsUuid) next.accountUuid = cfg.credsUuid;
    fs.writeFileSync(creds, JSON.stringify({ claudeAiOauth: next }));
    if (cfg.acct) fs.writeFileSync(cj, JSON.stringify(acctJson(cfg.acct)));
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })}\n`);
}
