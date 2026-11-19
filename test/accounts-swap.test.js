import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applySwap, credsPath } from '../src/accounts/creds.js';
import { loadRegistry, readUsage, writeUsage } from '../src/accounts/state.js';
import { memoryVault } from '../src/accounts/vault.js';
import { world, oauth, credsText, MCP, tmp } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const ROTATED = { ...RYAN, accessToken: 'sk-ant-oat01-FAKE-rotated-access', refreshToken: 'sk-ant-ort01-FAKE-rotated-refresh' };
const MCP_TEXT = `"mcpOAuth":${JSON.stringify(MCP)}`;

test('use: swaps only claudeAiOauth and organizationUuid, keeps mcpOAuth byte-identical and the compact format', async (t) => {
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: ROTATED });
  const before = w.live();
  const fileAtVaultWrite = [];
  const setMany = w.vault.setMany;
  w.vault.setMany = async (e) => { fileAtVaultWrite.push(fs.readFileSync(w.file, 'utf8')); return setMany(e); };

  const r = await w.m.use('orders', { reason: 'manual' });
  assert.deepEqual(r, { from: 'ryan', to: 'orders', switched: true });
  const after = w.live();
  const parsed = JSON.parse(after);
  assert.deepEqual(Object.keys(parsed), ['mcpOAuth', 'claudeAiOauth', 'organizationUuid']);
  assert.deepEqual(parsed.claudeAiOauth, ORDERS);
  assert.equal(parsed.organizationUuid, ORDERS.organizationUuid);
  assert.equal(after, JSON.stringify(parsed), 'still compact');
  assert.ok(before.includes(MCP_TEXT) && after.includes(MCP_TEXT), 'mcpOAuth byte-identical');

  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(ROTATED), 'the rotated live token is saved back');
  assert.equal(w.vault.entries.get('backup'), before, 'backup = the full previous file');
  assert.deepEqual(fileAtVaultWrite, [before], 'save-back and backup happen before the file changes');
  const reg = loadRegistry(w.dataDir);
  assert.deepEqual({ ...reg.lastSwitch, at: undefined }, { from: 'ryan', to: 'orders', at: undefined, reason: 'manual' });
  assert.equal(w.m.activeName(), 'orders');
});

test('use: a bad read-back restores the old text and fails', (t) => {
  const home = tmp(t, 'am-home-');
  const old = credsText(RYAN);
  fs.writeFileSync(path.join(home, '.credentials.json'), old);
  const broken = (file) => fs.writeFileSync(file, '{"claudeAiOauth":{"accountUuid":"uuid-orders"}}'); // mcpOAuth lost
  assert.throws(() => applySwap(home, old, ORDERS, { write: broken }), /previous login was restored/);
  assert.equal(fs.readFileSync(credsPath(home), 'utf8'), old);
  assert.throws(() => applySwap(home, old, ORDERS, { write: (file) => fs.writeFileSync(file, 'not json') }), /restored/);
  assert.equal(fs.readFileSync(credsPath(home), 'utf8'), old);
  fs.rmSync(credsPath(home));
  assert.throws(() => applySwap(home, null, ORDERS, { write: (file) => fs.writeFileSync(file, '{}') }), /restored/);
  assert.equal(fs.existsSync(credsPath(home)), false, 'no file before -> no file after');
});

test('use: failures before the write leave .credentials.json byte-identical', async (t) => {
  const failing = memoryVault();
  const realSetMany = failing.setMany;
  failing.setMany = async () => { throw new Error('vault: CredWriteW failed (error 5) on x'); };
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: ROTATED, vault: failing });
  const before = w.live();
  await assert.rejects(w.m.use('orders'), /CredWriteW/);
  assert.equal(w.live(), before);

  w.vault.entries.delete('account/orders');
  w.vault.setMany = realSetMany;
  await assert.rejects(w.m.use('orders'), /no saved login for "orders"/);
  assert.equal(w.live(), before);
  assert.equal(loadRegistry(w.dataDir).accounts.orders.savedAt, null, 'pickBest stops choosing it');

  w.vault.entries.set('account/orders', JSON.stringify(oauth('uuid-someone-else')));
  await assert.rejects(w.m.use('orders'), /belongs to another account/);
  w.vault.entries.set('account/orders', JSON.stringify({ ...ORDERS, refreshToken: '' }));
  await assert.rejects(w.m.use('orders'), /no saved login/);
  await assert.rejects(w.m.use('nobody'), /no account named "nobody"/);
  assert.equal(w.live(), before);

  fs.writeFileSync(w.file, '{"claudeAiOauth":');
  w.vault.entries.set('account/orders', JSON.stringify(ORDERS));
  await assert.rejects(w.m.use('orders'), /not valid JSON/);
  assert.equal(w.live(), '{"claudeAiOauth":');
  assert.equal(w.vault.entries.has('backup'), false);
});

test('use: the live account is not swapped, only saved back; a missing live file is created', async (t) => {
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: ROTATED });
  const before = w.live();
  assert.deepEqual(await w.m.use('ryan'), { from: 'ryan', to: 'ryan', switched: false });
  assert.equal(w.live(), before);
  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(ROTATED));

  fs.rmSync(w.file);
  assert.equal((await w.m.use('orders')).switched, true);
  assert.deepEqual(JSON.parse(w.live()), { claudeAiOauth: ORDERS, organizationUuid: ORDERS.organizationUuid });
  assert.equal(w.vault.entries.has('backup'), false, 'nothing to back up');
});

test('add --current saves the live login; the same login under another name is refused', async (t) => {
  const w = world(t, { live: RYAN });
  assert.equal(w.m.hasAccounts(), false);
  const r = await w.m.add('ryan', { current: true, email: 'ryan@example.com' });
  assert.deepEqual(r, { name: 'ryan', email: 'ryan@example.com', accountUuid: 'uuid-ryan' });
  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(RYAN));
  const a = loadRegistry(w.dataDir).accounts.ryan;
  assert.equal(a.accountUuid, 'uuid-ryan');
  assert.equal(a.refreshExpiresAt, new Date(RYAN.refreshTokenExpiresAt).toISOString());
  assert.ok(a.savedAt && a.addedAt);
  assert.ok(!JSON.stringify(loadRegistry(w.dataDir)).includes('FAKE'), 'no secrets in the registry');
  assert.equal(w.m.activeName(), 'ryan');

  await assert.rejects(w.m.add('second', { current: true }), /already saved as "ryan"/);
  fs.writeFileSync(w.file, credsText(ORDERS));
  await assert.rejects(w.m.add('ryan', { current: true }), /different account/);
  await assert.rejects(w.m.add('Bad Name', { current: true }), /invalid account name/);
  fs.writeFileSync(w.file, '{}');
  await assert.rejects(w.m.add('lab', { current: true }), /no usable live login/);
});

test('remove deletes the vault entry, the registry entry and the usage file', async (t) => {
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN });
  writeUsage(w.dataDir, 'orders', { reading: { five_hour: { used_percentage: 5, resets_at: 1 } }, limit: null });
  await w.m.remove('orders');
  assert.equal(w.vault.entries.has('account/orders'), false);
  assert.equal(loadRegistry(w.dataDir).accounts.orders, undefined);
  assert.deepEqual(readUsage(w.dataDir, 'orders'), { reading: null, limit: null });
  assert.equal(fs.existsSync(path.join(w.dataDir, 'accounts', 'usage-orders.json')), false);
  await assert.rejects(w.m.remove('orders'), /no account named/);
});

test('creds: the real ~/.claude is refused under node --test', async () => {
  const os = await import('node:os');
  assert.throws(() => credsPath(path.join(os.default.homedir(), '.claude')), /real ~\/\.claude/);
});

test('use: a live login that is not a saved account is refused (it would only survive in backup)', async (t) => {
  const stranger = oauth('uuid-stranger');
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: stranger });
  const before = w.live();
  await assert.rejects(w.m.use('orders'), /the live login is not a saved account; save it first: agent-monitor accounts add <name> --current/);
  assert.equal(w.live(), before);
  assert.equal(w.vault.entries.has('backup'), false);
});

test('use: a token rotated by a live process during the vault batch is saved too, then the swap goes through', async (t) => {
  const vault = memoryVault();
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN, vault });
  const realSetMany = vault.setMany;
  let calls = 0;
  vault.setMany = async (e) => {
    await realSetMany(e);
    if (++calls === 1) fs.writeFileSync(w.file, credsText(ROTATED)); // Claude Code rotates the token meanwhile
  };
  assert.equal((await w.m.use('orders')).switched, true);
  assert.equal(calls, 2);
  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(ROTATED), 'the newest token is what got saved');
  assert.equal(w.vault.entries.get('backup'), credsText(ROTATED), 'backup is the newest text');
  assert.equal(JSON.parse(w.live()).claudeAiOauth.accountUuid, 'uuid-orders');
});

test('use: a file that keeps changing fails after 3 re-checks without writing', async (t) => {
  const vault = memoryVault();
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN, vault });
  const realSetMany = vault.setMany;
  let n = 0;
  vault.setMany = async (e) => { await realSetMany(e); fs.writeFileSync(w.file, credsText({ ...RYAN, accessToken: `sk-ant-oat01-FAKE-r${++n}` })); };
  await assert.rejects(w.m.use('orders'), /keeps changing/);
  assert.equal(n, 4);
  assert.equal(JSON.parse(w.live()).claudeAiOauth.accountUuid, 'uuid-ryan', 'never swapped');
});
