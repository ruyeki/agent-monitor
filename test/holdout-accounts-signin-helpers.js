// Verifier helpers. Temp homes only, memory vault, fake tokens.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../src/accounts/index.js';
import { memoryVault } from '../src/accounts/vault.js';
import { saveRegistry } from '../src/accounts/state.js';

export const STUB = path.join(import.meta.dirname, 'fixtures', 'accounts-claude-2-1-287-stub.mjs');
export const NOW = Date.parse('2026-11-18T12:00:00Z');
export const DAY = 86400e3;
export const tmp = (t, p = 'vh-') => { const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p))); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
export const full = (id, extra = {}) => ({ accessToken: `sk-ant-oat01-FAKE-${id}-access`, refreshToken: `sk-ant-ort01-FAKE-${id}-refresh`, expiresAt: NOW + 3600e3, refreshTokenExpiresAt: NOW + 30 * DAY, scopes: ['user:inference'], subscriptionType: 'team', rateLimitTier: 'default', clientId: 'cid', accountUuid: id, organizationUuid: `org-${id}`, ...extra });
// 2.1.287 shape: the 8 fields, no accountUuid / organizationUuid.
export const bare = (id, suffix = '') => { const o = full(id); delete o.accountUuid; delete o.organizationUuid; o.accessToken += suffix; o.refreshToken += suffix; return o; };
export const acctJson = (id, extra = {}) => ({ oauthAccount: { accountUuid: id, emailAddress: `${id}@example.com`, organizationUuid: `org-${id}`, organizationName: 'O', ...extra }, numStartups: 3 });

export function vworld(t, { accounts = {}, live = null, acct, raw = null, lastSwitch = null, stub = null, ...rest } = {}) {
  const home = tmp(t, 'vh-home-');
  const dataDir = tmp(t, 'vh-data-');
  const vault = memoryVault();
  const at = new Date(NOW - DAY).toISOString();
  const reg = { accounts: {}, lastSwitch };
  for (const [name, o] of Object.entries(accounts)) {
    reg.accounts[name] = { accountUuid: o.accountUuid, email: `${name}@example.com`, addedAt: at, savedAt: at, refreshExpiresAt: new Date(o.refreshTokenExpiresAt).toISOString() };
    vault.entries.set(`account/${name}`, JSON.stringify(o));
  }
  if (Object.keys(accounts).length || lastSwitch) saveRegistry(dataDir, reg);
  const file = path.join(home, '.credentials.json');
  if (live) fs.writeFileSync(file, JSON.stringify({ mcpOAuth: { x: { serverName: 'x' } }, claudeAiOauth: live }));
  const cj = path.join(home, '.claude.json');
  if (acct) fs.writeFileSync(cj, JSON.stringify(acct));
  if (raw != null) fs.writeFileSync(cj, raw);
  const env = { ...process.env, VH_STUB: JSON.stringify(stub ?? {}) };
  const m = createAccounts({ dataDir, home, vault, claudeJson: cj, clock: () => NOW, claude: { command: process.execPath, args: [STUB] }, env, ...rest });
  t.after(() => m.close());
  return { home, dataDir, vault, m, file, cj, reg, live: () => fs.readFileSync(file, 'utf8'), snap: () => JSON.stringify([...vault.entries]), vaultOf: (n) => JSON.parse(vault.entries.get(`account/${n}`)) };
}
export const lsw = (from, to, ago = 2 * DAY) => ({ from, to, at: new Date(NOW - ago).toISOString(), reason: 'x' });
