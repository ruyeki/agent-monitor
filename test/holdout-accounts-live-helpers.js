// Shared by the stale-login verifier tests. Fake logins only.
import fs from 'node:fs';
import path from 'node:path';
import { world, oauth, credsText, tmp, readLog, NOW, DAY } from './accounts-helpers.js';
import { loadRegistry, saveRegistry } from '../src/accounts/state.js';

export const STUB = path.join(import.meta.dirname, 'fixtures', 'holdout-accounts-live-stub.mjs');
export const bare = (o) => { const { accountUuid, organizationUuid, ...rest } = o; return rest; };
export const U = (n) => `uuid-${n}`;
export const acct = (n) => ({ accountUuid: U(n), emailAddress: `${n}@example.com`, organizationUuid: `org-${U(n)}` });

// A world whose claude is the stub. cfg is changeable per test through w.cfg(...).
export function fvWorld(t, opts = {}) {
  const log = path.join(tmp(t, 'am-fvlog-'), 'stub.log');
  const env = { ...process.env, FV_LOG: log, FV_STUB: '{}' };
  const w = world(t, { claude: { command: process.execPath, args: [STUB] }, env, ...opts });
  w.cfg = (c) => { env.FV_STUB = JSON.stringify(c); };
  w.calls = () => readLog(log);
  w.claudeJson = path.join(w.home, '.claude.json');
  w.writeOa = (n) => fs.writeFileSync(w.claudeJson, JSON.stringify({ numStartups: 1, oauthAccount: n ? acct(n) : undefined }));
  w.writeLive = (o, bareToo = false) => fs.writeFileSync(w.file, credsText(bareToo ? bare(o) : o, o.organizationUuid));
  w.reg = () => loadRegistry(w.dataDir);
  w.vaultSnap = () => JSON.stringify([...w.vault.entries.entries()].sort());
  w.vtok = (name) => JSON.parse(w.vault.entries.get(`account/${name}`)).refreshToken;
  return w;
}
// A rotated copy of a login (what Claude Code writes after a renewal): new tokens, no accountUuid when bareToo.
export const renewed = (o, tag = 'renew') => ({ ...o, accessToken: `${o.accessToken}-${tag}`, refreshToken: `${o.refreshToken}-${tag}`, expiresAt: NOW + 7200_000 });
export { oauth, credsText, tmp, NOW, DAY, saveRegistry, loadRegistry };
