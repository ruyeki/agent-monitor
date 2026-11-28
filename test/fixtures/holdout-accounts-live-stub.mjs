// Stand-in claude for the stale-login verifier tests. Env FV_STUB = JSON {dead:[uuid], stuck:[uuid], other:[uuid]}; FV_LOG = call log.
// Rotates like Claude Code 2.1.287 (drops accountUuid/organizationUuid) unless the account is listed.
import fs from 'node:fs';
import path from 'node:path';
const cfg = JSON.parse(process.env.FV_STUB || '{}');
const dir = process.env.CLAUDE_CONFIG_DIR;
const file = dir ? path.join(dir, '.credentials.json') : null;
let seen = null;
try { seen = JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth ?? null; } catch { /* none */ }
process.stdin.setEncoding('utf8');
for await (const c of process.stdin) void c;
if (process.env.FV_LOG) fs.appendFileSync(process.env.FV_LOG, `${JSON.stringify({ uuid: seen?.accountUuid ?? null, configDir: dir ?? null })}\n`);
const id = seen?.accountUuid;
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
if (cfg.dead?.includes(id)) {
  fs.rmSync(file, { force: true });
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'login expired' });
  process.exit(1);
}
if (!cfg.stuck?.includes(id) && seen) {
  const { accountUuid, organizationUuid, ...rest } = seen;
  const next = { ...rest, accessToken: `${seen.accessToken}-rot`, refreshToken: `${seen.refreshToken}-rot`, expiresAt: Date.now() + 8 * 3600_000 };
  if (cfg.other?.includes(id)) next.accountUuid = 'someone-else';
  fs.writeFileSync(file, JSON.stringify({ claudeAiOauth: next }));
}
out({ type: 'result', subtype: 'success', is_error: false, result: 'OK' });
process.exit(0);
