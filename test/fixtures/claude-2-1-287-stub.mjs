// Stand-in for Claude Code 2.1.287 in the accounts tests. Never talks to Anthropic. Env AM_287_STUB, JSON:
//   login: {id, account: {accountUuid, emailAddress, organizationUuid}}, write: 'none' writes nothing, exit
//     `auth login ...` writes <dir>/.credentials.json = {claudeAiOauth: 8 fields, NO accountUuid} and
//     <dir>/.claude.json = {oauthAccount} (account), as 2.1.287 does.
//   refresh (any other argv): rebuilds claudeAiOauth with only the 8 fields from the seen login and rotated tokens
//     (never an accountUuid); oauthAccount: an object is written into <dir>/.claude.json, absent = untouched.
// AM_287_LOG: a file that gets one JSON line per call {argv, configDir}.
import fs from 'node:fs';
import path from 'node:path';

const cfg = JSON.parse(process.env.AM_287_STUB || '{}');
const argv = process.argv.slice(2);
const dir = process.env.CLAUDE_CONFIG_DIR;
const credsFile = path.join(dir, '.credentials.json');
const jsonFile = path.join(dir, '.claude.json');
if (process.env.AM_287_LOG) fs.appendFileSync(process.env.AM_287_LOG, `${JSON.stringify({ argv, configDir: dir })}\n`);
const EIGHT = ['accessToken', 'refreshToken', 'expiresAt', 'refreshTokenExpiresAt', 'scopes', 'subscriptionType', 'rateLimitTier', 'clientId'];
const pick = (o) => Object.fromEntries(EIGHT.filter((k) => k in o).map((k) => [k, o[k]]));

if (argv[0] === 'auth' && argv[1] === 'login') {
  if (cfg.login && cfg.write !== 'none') {
    const { id, account } = cfg.login;
    fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: {
      accessToken: `sk-ant-oat01-FAKE-${id}-access`, refreshToken: `sk-ant-ort01-FAKE-${id}-refresh`, expiresAt: Date.now() + 8 * 3600_000,
      refreshTokenExpiresAt: Date.now() + 30 * 86400_000, scopes: ['user:inference', 'user:profile'], subscriptionType: 'team',
      rateLimitTier: 'default_claude_max_5x', clientId: 'FAKE-client',
    } }));
    if (account) fs.writeFileSync(jsonFile, JSON.stringify({ oauthAccount: { organizationName: 'Org', ...account } }));
  }
  process.exitCode = cfg.exit ?? 0;
} else {
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) void chunk; // the prompt
  let seen = null;
  try { seen = JSON.parse(fs.readFileSync(credsFile, 'utf8')).claudeAiOauth ?? null; } catch { /* none */ }
  if (seen && cfg.write !== 'none') {
    fs.writeFileSync(credsFile, JSON.stringify({ claudeAiOauth: {
      ...pick(seen), accessToken: `${seen.accessToken}-rotated`, refreshToken: `${seen.refreshToken}-rotated`, expiresAt: Date.now() + 8 * 3600_000,
    } }));
    if (cfg.oauthAccount) fs.writeFileSync(jsonFile, JSON.stringify({ oauthAccount: cfg.oauthAccount }));
  }
  process.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'OK' })}\n`);
  process.exitCode = cfg.exit ?? 0;
}
