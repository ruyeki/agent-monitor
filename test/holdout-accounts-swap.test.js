// AC4 + AC6: credential swap, save-back, backup, atomicity, rollback, locking, sync-back.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  world, cred, writeCred, readCred, readCredText, credExists, credText, rejects, vaultTargets, filesWithTokens, sleep, until, loadAccounts, newPrefix, vaultWipe, tmp, load, readRegistry,
} from './holdout-accounts-helpers.js';

const setup = (t, o = {}) => world(t, { accounts: ['ana', 'bob', 'cyd'], active: 'ana', ...o });

test('use() replaces ONLY claudeAiOauth (+organizationUuid); mcpOAuth, key order and compact format are kept', async (t) => {
  const w = await setup(t);
  const mcp = { gh: { accessToken: 'MCP-ONLY-ANA', n: [1, 2, { z: 1 }] } };
  const before = cred('ana', { mcp });
  writeCred(w.home, before);
  await w.mgr.use('bob', { reason: 'manual' });
  const text = readCredText(w.home);
  const after = JSON.parse(text);
  assert.equal(after.claudeAiOauth.accountUuid, 'uuid-bob');
  assert.equal(after.claudeAiOauth.refreshToken, cred('bob').claudeAiOauth.refreshToken);
  assert.deepEqual(after.mcpOAuth, mcp, 'mcpOAuth untouched');
  assert.equal(after.organizationUuid, 'org-bob');
  assert.deepEqual(Object.keys(after), Object.keys(before));
  assert.deepEqual(Object.keys(after.claudeAiOauth), Object.keys(cred('bob').claudeAiOauth));
  assert.equal(text, JSON.stringify(after), 'still compact JSON');
  assert.equal(w.mgr.activeName(), 'bob');
});

test('use() saves the CURRENT login back first, so a rotated refresh token is never lost', async (t) => {
  const w = await setup(t);
  const c = cred('ana'); c.claudeAiOauth.refreshToken = 'AMVTOK-rt-ana-ROTATED'; c.claudeAiOauth.accessToken = 'AMVTOK-at-ana-ROTATED';
  writeCred(w.home, c);
  await w.mgr.use('bob');
  await w.mgr.use('cyd');
  await w.mgr.use('ana');
  const back = readCred(w.home).claudeAiOauth;
  assert.equal(back.refreshToken, 'AMVTOK-rt-ana-ROTATED');
  assert.equal(back.accessToken, 'AMVTOK-at-ana-ROTATED');
  assert.equal(w.mgr.activeName(), 'ana');
});

test('use() makes a backup of the whole previous file in the vault before writing, none on disk', async (t) => {
  const w = await setup(t);
  await w.mgr.use('bob');
  const targets = vaultTargets(w.prefix);
  assert.ok(targets.some((x) => x === `${w.prefix}backup` || x.startsWith(`${w.prefix}backup`)), 'backup entry exists');
  assert.ok(targets.some((x) => x.startsWith(`${w.prefix}account/ana`)));
  assert.deepEqual(filesWithTokens(w.dataDir), []);
});

test('a login with a huge blob (over the Credential Manager limit) round-trips intact', async (t) => {
  const w = await world(t, { accounts: [] });
  writeCred(w.home, cred('big', { big: true }));
  await w.mgr.add('big', { current: true });
  writeCred(w.home, cred('ana'));
  await w.mgr.add('ana', { current: true });
  await w.mgr.use('big');
  assert.equal(readCred(w.home).claudeAiOauth.accessToken, cred('big', { big: true }).claudeAiOauth.accessToken);
  await w.mgr.use('ana');
  await w.mgr.use('big');
  assert.equal(readCred(w.home).claudeAiOauth.accessToken.length, cred('big', { big: true }).claudeAiOauth.accessToken.length);
});

test('use() of an unknown or badly named account fails and leaves the file byte-identical', async (t) => {
  const w = await setup(t);
  const before = readCredText(w.home);
  for (const n of ['nope', '', '../ana', 'ANA']) assert.ok(await rejects(() => w.mgr.use(n)), `use(${JSON.stringify(n)}) refused`);
  assert.equal(readCredText(w.home), before);
  assert.equal(w.mgr.activeName(), 'ana');
});

test('a saved login that is incomplete is refused before anything is written', async (t) => {
  const w = await world(t, { accounts: [] });
  writeCred(w.home, cred('ana')); await w.mgr.add('ana', { current: true });
  const bad = cred('bad'); bad.claudeAiOauth.refreshToken = '';
  writeCred(w.home, bad);
  let added = true;
  try { const r = await w.mgr.add('bad', { current: true }); added = !(r && (r.ok === false || r.error)); } catch { added = false; }
  writeCred(w.home, cred('ana'));
  const before = readCredText(w.home);
  if (added) assert.ok(await rejects(() => w.mgr.use('bad')), 'an empty refreshToken must not be swapped in');
  assert.equal(readCredText(w.home), before);
});

test('swap failure leaves the old file untouched and cleans up (read-only file blocks the atomic replace)', async (t) => {
  const w = await setup(t);
  const before = readCredText(w.home);
  const file = path.join(w.home, '.credentials.json');
  fs.chmodSync(file, 0o444);
  const failed = await rejects(() => w.mgr.use('bob'));
  fs.chmodSync(file, 0o666);
  assert.ok(failed, 'the swap reports failure');
  assert.equal(readCredText(w.home), before, 'old login intact');
  assert.equal(w.mgr.activeName(), 'ana');
  assert.deepEqual(fs.readdirSync(w.home), ['.credentials.json'], 'no temp files left behind');
  await w.mgr.use('bob'); // and the next attempt works
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-bob');
});

test('with no credentials file at all, use() creates it with only the new login', async (t) => {
  const w = await setup(t);
  fs.rmSync(path.join(w.home, '.credentials.json'));
  await w.mgr.use('cyd');
  const after = readCred(w.home);
  assert.equal(after.claudeAiOauth.accountUuid, 'uuid-cyd');
  assert.equal(w.mgr.activeName(), 'cyd');
});

test('activeName() follows the accountUuid in the file; unknown login or no file means null', async (t) => {
  const w = await setup(t);
  assert.equal(w.mgr.activeName(), 'ana');
  writeCred(w.home, cred('stranger'));
  assert.equal(w.mgr.activeName(), null);
  fs.rmSync(path.join(w.home, '.credentials.json'));
  assert.equal(w.mgr.activeName(), null);
  fs.writeFileSync(path.join(w.home, '.credentials.json'), '{not json');
  assert.equal(w.mgr.activeName(), null);
});

test('a login file the manager cannot parse is never overwritten by a swap', async (t) => {
  const w = await setup(t);
  fs.writeFileSync(path.join(w.home, '.credentials.json'), '{"claudeAiOauth": truncated');
  const junk = readCredText(w.home);
  const failed = await rejects(() => w.mgr.use('bob'));
  // either it refuses (and the file is untouched) or it backed the junk up first; the junk must not just vanish
  if (failed) assert.equal(readCredText(w.home), junk);
  else assert.ok(vaultTargets(w.prefix).some((x) => x.startsWith(`${w.prefix}backup`)), 'junk was backed up before being replaced');
});

test('two swaps at once (two managers, one home) end in a valid file for one of the two targets, nothing lost', async (t) => {
  const w = await setup(t);
  const { createAccounts } = await loadAccounts();
  const { createVault } = await load('src/accounts/vault.js');
  const mgr2 = createAccounts({ dataDir: w.dataDir, home: w.home, vault: createVault({ prefix: w.prefix }), claude: w.fakeClaude, spawn: w.spawn, clock: w.clock });
  t.after(() => mgr2.close?.());
  const mcp = cred('ana').mcpOAuth;
  const rs = await Promise.allSettled([w.mgr.use('bob'), mgr2.use('cyd')]);
  assert.ok(rs.some((r) => r.status === 'fulfilled'));
  const after = readCred(w.home);
  assert.ok(['uuid-bob', 'uuid-cyd'].includes(after.claudeAiOauth.accountUuid));
  assert.deepEqual(after.mcpOAuth, mcp);
  assert.equal(w.mgr.activeName(), after.claudeAiOauth.accountUuid.replace('uuid-', ''));
  // the first account's login must still be restorable
  await w.mgr.use('ana');
  assert.equal(readCred(w.home).claudeAiOauth.refreshToken, cred('ana').claudeAiOauth.refreshToken);
});

test('a stale lock (older than 60 s) does not block a swap', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana' }); // real clock via default Date? uses injected clock; lock age uses file mtime
  const dir = path.join(w.dataDir, 'accounts'); fs.mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.lock'); fs.writeFileSync(lock, '1');
  const old = new Date(Date.now() - 5 * 60e3); fs.utimesSync(lock, old, old);
  await w.mgr.use('bob');
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-bob');
  assert.ok(!fs.existsSync(lock), 'lock released');
});

test('sync-back: when the live login rotates, the saved copy follows it (via syncBack and via startSync)', async (t) => {
  const w = await setup(t);
  const rot = cred('ana'); rot.claudeAiOauth.refreshToken = 'AMVTOK-rt-ana-SYNCED'; rot.claudeAiOauth.accessToken = 'AMVTOK-at-ana-SYNCED';
  writeCred(w.home, rot);
  await w.mgr.syncBack();
  await w.mgr.use('bob');
  await w.mgr.use('ana');
  assert.equal(readCred(w.home).claudeAiOauth.refreshToken, 'AMVTOK-rt-ana-SYNCED', 'syncBack saved the rotation');
  // now the watcher path
  w.mgr.startSync({ intervalMs: 100 });
  await sleep(300);
  const rot2 = cred('ana'); rot2.claudeAiOauth.refreshToken = 'AMVTOK-rt-ana-SYNCED2'; rot2.claudeAiOauth.accessToken = 'AMVTOK-at-ana-SYNCED2';
  writeCred(w.home, rot2);
  await sleep(1800);
  w.mgr.close?.();
  await w.mgr.use('bob');
  await w.mgr.use('ana');
  assert.equal(readCred(w.home).claudeAiOauth.refreshToken, 'AMVTOK-rt-ana-SYNCED2', 'watcher saved the rotation');
});

test('an unregistered live login is never swapped away: use() rejects, file byte-identical, handleLimit gives next null + error', async (t) => {
  const w = await setup(t);
  writeCred(w.home, cred('stranger'));
  const before = readCredText(w.home);
  assert.ok(await rejects(() => w.mgr.use('bob')), 'use refused');
  assert.equal(readCredText(w.home), before, 'live file untouched after use');
  const r = await w.mgr.handleLimit({ runAccount: 'ana', source: 'limit' });
  assert.equal(r.next, null);
  assert.ok(r.error, 'handleLimit reports an error');
  assert.equal(readCredText(w.home), before, 'live file untouched after handleLimit');
});

test('refreshDue(): only saved, NON-active accounts whose refresh token expires within 7 days', async (t) => {
  const w = await world(t, { accounts: [] });
  for (const [n, d] of [['ana', 1], ['bob', 3], ['cyd', 20], ['dee', 6.9], ['eve', 7.5]]) {
    writeCred(w.home, cred(n, { refreshExp: 1e3 * Math.floor((Date.parse('2026-11-18T10:00:00Z') + d * 864e5) / 1e3) }));
    await w.mgr.add(n, { current: true });
  }
  writeCred(w.home, cred('ana', { refreshExp: Date.parse('2026-11-18T10:00:00Z') + 864e5 })); // ana is active
  const due = ((await w.mgr.refreshDue()) ?? []).map((x) => (typeof x === 'string' ? x : x.name)).sort();
  assert.deepEqual(due, ['bob', 'dee']);
});
