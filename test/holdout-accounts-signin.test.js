// t2200-signin-fix: 2.1.287 credentials without accountUuid (sign-in, add, refresh, record, paths).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as creds from '../src/accounts/creds.js';
import * as paths from '../src/accounts/paths.js';
import { refreshLogin, signIn } from '../src/accounts/refresh.js';
import { recordWindows } from '../src/accounts/record.js';
import { readUsage, loadRegistry } from '../src/accounts/state.js';
import { vworld, full, bare, acctJson, lsw, tmp, STUB, NOW } from './holdout-accounts-signin-helpers.js';

const claude = { command: process.execPath, args: [STUB] };
const envOf = (cfg) => ({ ...process.env, VH_STUB: JSON.stringify(cfg) });
const L = (cfg, extra = {}) => ({ uuid: 'u-orders', email: 'orders@example.com', ...cfg, ...extra });
const bytes = (f) => fs.readFileSync(f);

// ---- AC1: add / signIn ----
test('AC1 add: login without accountUuid is saved with identity from oauthAccount', async (t) => {
  const w = vworld(t, { stub: L() });
  const r = await w.m.add('orders', { email: 'orders@example.com' });
  assert.equal(r.accountUuid, 'u-orders');
  const v = w.vaultOf('orders');
  assert.equal(v.accountUuid, 'u-orders');
  assert.equal(v.organizationUuid, 'org-u-orders');
  assert.match(v.accessToken, /FAKE/);
  assert.equal(loadRegistry(w.dataDir).accounts.orders.email, 'orders@example.com');
  assert.equal(loadRegistry(w.dataDir).accounts.orders.accountUuid, 'u-orders');
});

test('AC1 add without --email: registry email comes from oauthAccount', async (t) => {
  const w = vworld(t, { stub: L({ email: 'Found@Example.com' }) });
  const r = await w.m.add('orders');
  assert.equal(r.email, 'Found@Example.com');
});

test('AC1 add: --email compared case-insensitively', async (t) => {
  const w = vworld(t, { stub: L({ email: 'Orders@Example.com' }) });
  await w.m.add('orders', { email: 'orders@example.com' });
  assert.equal(w.vaultOf('orders').accountUuid, 'u-orders');
});

test('AC1 add: wrong signed-in email is refused, names it, saves nothing', async (t) => {
  const w = vworld(t, { stub: L({ uuid: 'u-ryan', email: 'ryan@example.com' }) });
  await assert.rejects(() => w.m.add('orders', { email: 'orders@example.com' }), (e) => /ryan@example\.com/.test(e.message) && /orders@example\.com/.test(e.message));
  assert.equal(w.vault.entries.size, 0);
  assert.deepEqual(Object.keys(loadRegistry(w.dataDir).accounts), []);
});

test('AC1 add: --email given but signed-in email unknown -> accepted, registry uses the given one', async (t) => {
  const w = vworld(t, { stub: L({ email: null }) });
  const r = await w.m.add('orders', { email: 'given@example.com' });
  assert.equal(r.email, 'given@example.com');
  assert.equal(w.vaultOf('orders').accountUuid, 'u-orders');
});

test('AC1 signIn: credentials accountUuid and oauthAccount disagree -> refused', async () => {
  await assert.rejects(() => signIn({ claude, env: envOf(L({ credsUuid: 'u-other' })) }));
});

test('AC1 signIn: credentials accountUuid agreeing with oauthAccount is fine', async () => {
  const r = await signIn({ claude, env: envOf(L({ credsUuid: 'u-orders' })) });
  assert.equal(r.oauth.accountUuid, 'u-orders');
});

test('AC1 signIn: tokens but no identity anywhere -> "sign-in did not finish"', async () => {
  await assert.rejects(() => signIn({ claude, env: envOf(L({ noOauthAccount: true })) }), /sign-in did not finish/);
});

test('AC1 signIn: no tokens -> "sign-in did not finish"', async () => {
  await assert.rejects(() => signIn({ claude, env: envOf(L({ noTokens: true })) }), /sign-in did not finish/);
});

test('AC1 signIn returns oauth with accountUuid + organizationUuid and email, temp dir removed', async () => {
  const log = path.join(os.tmpdir(), `vh-log-${process.pid}-${Date.now()}`);
  const r = await signIn({ claude, env: { ...envOf(L()), VH_LOG: log } });
  assert.equal(r.oauth.accountUuid, 'u-orders');
  assert.equal(r.oauth.organizationUuid, 'org-u-orders');
  assert.equal(r.email, 'orders@example.com');
  const dir = JSON.parse(fs.readFileSync(log, 'utf8').split('\n')[0]).dir;
  fs.rmSync(log, { force: true });
  assert.equal(fs.existsSync(dir), false);
});

test('AC1 add: the same login saved under a second name is still refused', async (t) => {
  const w = vworld(t, { stub: L() });
  await w.m.add('orders', {});
  await assert.rejects(() => w.m.add('other', {}), /already saved as "orders"/);
});

// ---- AC2: refreshLogin ----
const SAVED = full('u-lab');
test('AC2 refreshLogin: refresh dropped accountUuid, no oauthAccount -> inherits saved identity', async () => {
  const { oauth } = await refreshLogin(SAVED, { claude, env: envOf({}) });
  assert.equal(oauth.accountUuid, 'u-lab');
  assert.equal(oauth.organizationUuid, 'org-u-lab');
  assert.equal(oauth.refreshToken, `${SAVED.refreshToken}-r`);
  assert.ok(oauth.expiresAt > 0);
});

test('AC2 refreshLogin: oauthAccount for the same account is accepted', async () => {
  const { oauth } = await refreshLogin(SAVED, { claude, env: envOf({ acct: { uuid: 'u-lab', email: 'lab@example.com' } }) });
  assert.equal(oauth.accountUuid, 'u-lab');
});

test('AC2 refreshLogin: oauthAccount for another account is refused', async () => {
  await assert.rejects(() => refreshLogin(SAVED, { claude, env: envOf({ acct: { uuid: 'u-ryan', email: 'ryan@example.com' } }) }));
});

test('AC2 refreshLogin: credentials accountUuid for another account is refused', async () => {
  await assert.rejects(() => refreshLogin(SAVED, { claude, env: envOf({ credsUuid: 'u-ryan' }) }));
});

test('AC2 refreshLogin: nothing rewritten (expiresAt stays 0) is still refused', async () => {
  await assert.rejects(() => refreshLogin(SAVED, { claude, env: envOf({ write: 'none' }) }), /did not refresh/);
});

test('AC2 refresh() end to end: vault value keeps accountUuid and has the rotated token', async (t) => {
  const A = full('u-a');
  const B = full('u-b');
  const w = vworld(t, { accounts: { a: A, b: B }, live: B });
  await w.m.refresh('a');
  const v = w.vaultOf('a');
  assert.equal(v.accountUuid, 'u-a');
  assert.equal(v.refreshToken, `${A.refreshToken}-r`);
});

// ---- AC3: identity helpers ----
const regOf = (accts, lastSwitch = null) => ({ accounts: Object.fromEntries(Object.entries(accts).map(([n, u]) => [n, { accountUuid: u }])), lastSwitch });
function ident(t, { live, acct, raw, reg = regOf({}) }) {
  const home = tmp(t);
  if (live) fs.writeFileSync(path.join(home, '.credentials.json'), JSON.stringify({ claudeAiOauth: live }));
  const claudeJson = path.join(home, '.claude.json');
  if (acct) fs.writeFileSync(claudeJson, JSON.stringify(acct));
  if (raw != null) fs.writeFileSync(claudeJson, raw);
  return creds.liveIdentity({ home, claudeJson, reg });
}
const NONE = { oauth: null, accountUuid: null, email: null };

test('AC3 readOauthAccount: shapes', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'c.json');
  assert.equal(creds.readOauthAccount(f), null);
  fs.writeFileSync(f, '{"oauthAccount":{"accountUuid":"u1"}}');
  assert.deepEqual(creds.readOauthAccount(f), { accountUuid: 'u1', email: null, organizationUuid: null });
  fs.writeFileSync(f, JSON.stringify(acctJson('u2')));
  assert.deepEqual(creds.readOauthAccount(f), { accountUuid: 'u2', email: 'u2@example.com', organizationUuid: 'org-u2' });
  for (const bad of ['garbage', '[]', 'null', '{"oauthAccount":null}', '{"oauthAccount":{"accountUuid":""}}', '{"oauthAccount":{"accountUuid":5}}', '{"oauthAccount":[]}']) {
    fs.writeFileSync(f, bad);
    assert.equal(creds.readOauthAccount(f), null, bad);
  }
});

test('AC3 readOauthAccount: duplicate keys and big files do not throw', (t) => {
  const d = tmp(t);
  const f = path.join(d, 'c.json');
  fs.writeFileSync(f, `{"a":1,"a":2,"oauthAccount":{"accountUuid":"u1","emailAddress":"e@x"},"pad":"${'x'.repeat(200000)}"}`);
  assert.equal(creds.readOauthAccount(f).accountUuid, 'u1');
});

test('AC3 hasTokens / validOauth', () => {
  assert.equal(creds.hasTokens(bare('x')), true);
  assert.equal(creds.hasTokens({ accessToken: 'a' }), false);
  assert.equal(creds.hasTokens({ accessToken: '', refreshToken: 'r' }), false);
  assert.equal(creds.hasTokens(null), false);
  assert.equal(creds.validOauth(bare('x')), false);
  assert.equal(creds.validOauth(full('x')), true);
});

test('AC3 liveIdentity: no file / no tokens -> no live login, reason null', (t) => {
  assert.deepEqual(ident(t, {}), { ...NONE, reason: null });
  assert.deepEqual(ident(t, { live: { accessToken: 'a' }, acct: acctJson('u1') }), { ...NONE, reason: null });
});

test('AC3 liveIdentity: creds accountUuid trusted as is', (t) => {
  const live = full('u1');
  const r = ident(t, { live, acct: acctJson('someone-else'), reg: regOf({ a: 'u1', b: 'someone-else' }, lsw('a', 'b')) });
  assert.equal(r.accountUuid, 'u1');
  assert.deepEqual(r.oauth, live);
});

test('AC3 liveIdentity: no accountUuid, oauthAccount, no lastSwitch -> trusted and filled', (t) => {
  const r = ident(t, { live: bare('u1'), acct: acctJson('u1'), reg: regOf({ a: 'u1' }) });
  assert.equal(r.accountUuid, 'u1');
  assert.equal(r.email, 'u1@example.com');
  assert.equal(r.oauth.accountUuid, 'u1');
  assert.equal(r.oauth.organizationUuid, 'org-u1');
  assert.equal(r.oauth.accessToken, bare('u1').accessToken);
  assert.equal(r.reason ?? null, null);
});

test('AC3 liveIdentity: live organizationUuid wins over oauthAccount', (t) => {
  const r = ident(t, { live: { ...bare('u1'), organizationUuid: 'org-live' }, acct: acctJson('u1') });
  assert.equal(r.oauth.organizationUuid, 'org-live');
});

test('AC3 liveIdentity: lastSwitch matches oauthAccount -> trusted', (t) => {
  const r = ident(t, { live: bare('b'), acct: acctJson('b'), reg: regOf({ a: 'a', b: 'b' }, lsw('a', 'b')) });
  assert.equal(r.accountUuid, 'b');
});

test('AC3 liveIdentity: lastSwitch.to differs from oauthAccount -> uncertain with a plain reason', (t) => {
  const r = ident(t, { live: bare('b'), acct: acctJson('a'), reg: regOf({ a: 'a', b: 'b' }, lsw('a', 'b')) });
  assert.deepEqual({ oauth: r.oauth, accountUuid: r.accountUuid, email: r.email }, NONE);
  assert.equal(typeof r.reason, 'string');
  assert.match(r.reason, /a@example\.com/);
  assert.match(r.reason, /\/login/);
});

test('AC3 liveIdentity: lastSwitch.to missing from the registry counts as a mismatch', (t) => {
  const r = ident(t, { live: bare('b'), acct: acctJson('b'), reg: regOf({ a: 'a' }, lsw('a', 'gone')) });
  assert.equal(r.oauth, null);
  assert.ok(r.reason);
});

test('AC3 liveIdentity: no oauthAccount / unreadable .claude.json -> uncertain, never throws', (t) => {
  for (const raw of [null, 'garbage', '[]', '{"oauthAccount":{"accountUuid":""}}']) {
    const r = ident(t, { live: bare('b'), raw });
    assert.equal(r.oauth, null, String(raw));
    assert.equal(r.accountUuid, null);
    assert.ok(r.reason);
  }
});

test('AC3 liveIdentity: never throws on bad inputs', () => {
  assert.doesNotThrow(() => creds.liveIdentity({ home: '/nonexistent-vh', claudeJson: '/nonexistent-vh/.claude.json', reg: { accounts: {}, lastSwitch: null } }));
  assert.doesNotThrow(() => creds.liveIdentity({ home: '/nonexistent-vh', claudeJson: '/nonexistent-vh/.claude.json', reg: { accounts: {} } }));
});

// ---- AC3: manager behaviour ----
const TWO = () => ({ a: full('a'), b: full('b') });
const rotated = (id) => bare(id, '-rot');

test('AC3 syncBack: refresh dropped accountUuid, no lastSwitch -> saved under the right account, with accountUuid', async (t) => {
  const w = vworld(t, { accounts: TWO(), live: rotated('b'), acct: acctJson('b') });
  assert.equal(await w.m.syncBack(), true);
  const v = w.vaultOf('b');
  assert.equal(v.accountUuid, 'b');
  assert.equal(v.refreshToken, rotated('b').refreshToken);
  assert.equal(w.vaultOf('a').accountUuid, 'a');
  assert.equal(w.vaultOf('a').refreshToken, full('a').refreshToken);
});

test('AC3 real swap then a 2.1.287 refresh, oauthAccount names the new account: sync-back saves it with accountUuid', async (t) => {
  const w = vworld(t, { accounts: TWO(), live: full('a'), acct: acctJson('a') });
  await w.m.use('b');
  assert.equal(loadRegistry(w.dataDir).lastSwitch.to, 'b');
  fs.writeFileSync(w.file, JSON.stringify({ claudeAiOauth: rotated('b') }));
  fs.writeFileSync(w.cj, JSON.stringify(acctJson('b')));
  assert.equal(w.m.activeName(), 'b');
  assert.equal(await w.m.syncBack(), true);
  assert.equal(w.vaultOf('b').accountUuid, 'b');
  assert.equal(w.vaultOf('b').refreshToken, rotated('b').refreshToken);
});

// switched to b, Claude Code refreshed b (accountUuid dropped), .claude.json still names a
const ambiguous = (t) => vworld(t, { accounts: TWO(), live: rotated('b'), acct: acctJson('a'), lastSwitch: lsw('a', 'b') });

test('AC3 ambiguous: syncBack saves nothing, activeName null', async (t) => {
  const w = ambiguous(t);
  const before = w.snap();
  assert.notEqual(await w.m.syncBack(), true);
  assert.equal(w.snap(), before);
  assert.equal(w.m.activeName(), null);
  assert.equal(w.m.list().some((r) => r.active), false);
});

test('AC3 ambiguous: use() throws the reason before any write', async (t) => {
  const w = ambiguous(t);
  const before = w.snap();
  const live = bytes(w.file);
  await assert.rejects(() => w.m.use('a'), (e) => /cannot tell which account the live login is/.test(e.message) && /not switching/.test(e.message));
  assert.equal(w.snap(), before, 'vault unchanged, no backup written');
  assert.deepEqual(bytes(w.file), live);
  assert.equal(w.vault.entries.has('backup'), false);
});

test('AC3 ambiguous: handleLimit falls back (next null + error), nothing written', async (t) => {
  const w = ambiguous(t);
  const before = w.snap();
  const live = bytes(w.file);
  const r = await w.m.handleLimit({ at: new Date(NOW).toISOString(), resetsAt: Math.floor((NOW + 3600e3) / 1000), source: 'stopfailure' });
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(String(r.error), /cannot tell/);
  assert.equal(w.snap(), before);
  assert.deepEqual(bytes(w.file), live);
});

test('AC3 ambiguous: statusline reading is not put on the stale account', (t) => {
  const w = ambiguous(t);
  const reading = { five_hour: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 3600e3) / 1000) } };
  assert.equal(recordWindows({ dataDir: w.dataDir, home: w.home, reading, now: NOW }), null);
  assert.equal(readUsage(w.dataDir, 'a').reading, null);
});

test('AC3 recordWindows: trusted identity from oauthAccount attributes the reading to the live account', (t) => {
  const w = vworld(t, { accounts: TWO(), live: rotated('b'), acct: acctJson('b'), lastSwitch: lsw('a', 'b') });
  const reading = { five_hour: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 3600e3) / 1000) } };
  assert.equal(recordWindows({ dataDir: w.dataDir, home: w.home, reading, now: NOW }), 'b');
  assert.equal(recordWindows({ dataDir: w.dataDir, home: w.home, reading, now: NOW, claudeJson: w.cj }), 'b');
});

test('AC3 no oauthAccount at all and no accountUuid: use() refuses, live and vault untouched', async (t) => {
  const w = vworld(t, { accounts: TWO(), live: rotated('b') });
  const before = w.snap();
  const live = bytes(w.file);
  await assert.rejects(() => w.m.use('a'), /cannot tell which account the live login is/);
  assert.equal(w.snap(), before);
  assert.deepEqual(bytes(w.file), live);
});

test('AC3 certain-but-unregistered live login keeps the existing "not a saved account" refusal', async (t) => {
  const w = vworld(t, { accounts: TWO(), live: bare('c'), acct: acctJson('c') });
  await assert.rejects(() => w.m.use('a'), /not a saved account/);
});

test('AC3 swap save-back stores the identity-filled live login (certain via oauthAccount)', async (t) => {
  const w = vworld(t, { accounts: TWO(), live: rotated('b'), acct: acctJson('b') });
  const r = await w.m.use('a');
  assert.equal(r.switched, true);
  assert.equal(w.vaultOf('b').accountUuid, 'b');
  assert.equal(w.vaultOf('b').refreshToken, rotated('b').refreshToken);
  assert.equal(JSON.parse(w.live()).claudeAiOauth.accountUuid, 'a');
});

test('AC3 add --current: filled identity saved; uncertain refused; no tokens keeps the old message', async (t) => {
  const w = vworld(t, { live: bare('c'), acct: acctJson('c') });
  const r = await w.m.add('c', { current: true });
  assert.equal(r.accountUuid, 'c');
  assert.equal(w.vaultOf('c').accountUuid, 'c');
  const w2 = vworld(t, { live: bare('c') });
  await assert.rejects(() => w2.m.add('c', { current: true }));
  assert.equal(w2.vault.entries.size, 0);
  const w3 = vworld(t, { live: { accessToken: 'a' }, acct: acctJson('c') });
  await assert.rejects(() => w3.m.add('c', { current: true }), /no usable live login/);
});

test('AC3 .claude.json is never written (content and mtime unchanged through syncBack, list, use, add --current)', async (t) => {
  const raw = '{"numStartups":1,"numStartups":2,"oauthAccount":{"accountUuid":"b","emailAddress":"b@example.com"},"z": [1,2,  3]}';
  const w = vworld(t, { accounts: TWO(), live: rotated('b'), raw });
  const m0 = fs.statSync(w.cj).mtimeMs;
  await w.m.syncBack();
  w.m.list();
  await w.m.use('a');
  await w.m.add('x', { current: true }).catch(() => {});
  assert.equal(fs.readFileSync(w.cj, 'utf8'), raw);
  assert.equal(fs.statSync(w.cj).mtimeMs, m0);
});

// ---- paths / guard ----
test('AC3 defaults(): claudeJson location rules', (t) => {
  const a = tmp(t); const b = tmp(t); const d = tmp(t);
  assert.equal(paths.defaults({ CLAUDE_CONFIG_DIR: a, AGENT_MONITOR_HOME: d, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-abc/' }).claudeJson, path.join(a, '.claude.json'));
  assert.equal(paths.defaults({ CLAUDE_CONFIG_DIR: a, AGENT_MONITOR_CLAUDE_HOME: b, AGENT_MONITOR_HOME: d, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-abc/' }).claudeJson, path.join(b, '.claude.json'));
});

test('AC5 guard: the real ~/.claude.json is refused under node --test, a temp one is not', (t) => {
  const real = path.join(os.homedir(), '.claude.json');
  assert.equal(paths.isRealClaude(real), true);
  assert.throws(() => paths.guardReal(real), /refusing/);
  assert.doesNotThrow(() => paths.guardReal(path.join(tmp(t), '.claude.json')));
});
