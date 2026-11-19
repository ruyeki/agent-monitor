// Shared by the accounts tests. Not a test file. Fake logins only; temp homes and data dirs, removed after each test.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccounts } from '../src/accounts/index.js';
import { memoryVault } from '../src/accounts/vault.js';
import { saveRegistry, writeUsage } from '../src/accounts/state.js';

export const STUB = path.join(import.meta.dirname, 'fixtures', 'claude-login-stub.mjs');
export const NOW = Date.parse('2026-11-18T12:00:00Z');
export const DAY = 86400_000;

export function tmp(t, prefix = 'am-acct-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake claudeAiOauth with the real field set. Token text contains FAKE so leaks are easy to grep for.
export const oauth = (uuid, extra = {}) => ({
  accessToken: `sk-ant-oat01-FAKE-${uuid}-access`, refreshToken: `sk-ant-ort01-FAKE-${uuid}-refresh`, expiresAt: NOW + 3600_000,
  refreshTokenExpiresAt: NOW + 30 * DAY, scopes: ['user:inference', 'user:profile'], subscriptionType: 'team',
  subscriptionTypeSource: 'org', rateLimitTier: 'default_claude_max_5x', accountUuid: uuid, organizationUuid: `org-${uuid}`, ...extra,
});
export const MCP = { 'srv|1a2b': { serverName: 'srv', serverUrl: 'https://mcp.example/x', accessToken: 'mcp-FAKE-token', expiresAt: 1795000000000, clientId: 'c' } };

// Compact like Claude Code writes it: mcpOAuth first, then claudeAiOauth, then organizationUuid.
export const credsText = (o, org = o?.organizationUuid) => JSON.stringify({ mcpOAuth: MCP, claudeAiOauth: o, organizationUuid: org });

// A temp home + data dir + memory vault + manager. accounts: {name: oauth}; live: the oauth in .credentials.json.
export function world(t, { accounts = {}, live = null, usage = {}, vault = memoryVault(), clock, ...opts } = {}) {
  const home = tmp(t, 'am-home-');
  const dataDir = tmp(t, 'am-data-');
  const at = new Date(NOW - DAY).toISOString();
  const reg = { accounts: {}, lastSwitch: null };
  for (const [name, o] of Object.entries(accounts)) {
    reg.accounts[name] = { accountUuid: o.accountUuid, email: `${name}@example.com`, addedAt: at, savedAt: at, refreshExpiresAt: new Date(o.refreshTokenExpiresAt).toISOString() };
    vault.entries?.set(`account/${name}`, JSON.stringify(o));
  }
  if (Object.keys(accounts).length) saveRegistry(dataDir, reg);
  for (const [name, u] of Object.entries(usage)) writeUsage(dataDir, name, { reading: null, limit: null, ...u });
  const file = path.join(home, '.credentials.json');
  if (live) fs.writeFileSync(file, credsText(live));
  const time = { now: NOW };
  const m = createAccounts({ dataDir, home, vault, clock: clock ?? (() => time.now), ...opts });
  t.after(() => m.close());
  return { home, dataDir, vault, m, time, file, live: () => fs.readFileSync(file, 'utf8') };
}

export const win = (pct, resetsAt) => ({ used_percentage: pct, resets_at: resetsAt });
export const secs = (ms) => Math.round(ms / 1000);
export const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
export const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
