// The carried live identity (registry.live) across Claude Code's token renewals and manual logins, and the pre-switch check.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, withLock } from '../src/accounts/state.js';
import { liveIdentity } from '../src/accounts/creds.js';
import { DEAD_LOGIN } from '../src/accounts/refresh.js';
import { world, oauth, tmp, readLog, STUB, NOW, win, secs } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const LAB = oauth('uuid-lab');
const NEW = oauth('uuid-new');
const R = secs(NOW + 2 * 3600_000);
const at = new Date(NOW).toISOString();
const three = { ryan: RYAN, orders: ORDERS, lab: LAB };
const usage = { orders: { reading: { five_hour: win(10, R + 3600), seven_day: null } }, lab: { reading: { five_hour: win(50, R + 7200), seven_day: null } } };
const hit = { at: new Date(R * 1000).toISOString(), resetsAt: new Date(R * 1000).toISOString(), source: 'stopfailure' };

const bare = (o) => { const { accountUuid, organizationUuid, ...rest } = o; return rest; };
const rotated = (o, n = 1) => ({ ...o, accessToken: `${o.accessToken}-r${n}`, refreshToken: `${o.refreshToken}-r${n}` });
const setOa = (w, uuid) => fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ oauthAccount: uuid ? { accountUuid: uuid, emailAddress: `${uuid}@x.com`, organizationUuid: `org-${uuid}` } : undefined }));
const setCreds = (w, o) => fs.writeFileSync(w.file, JSON.stringify({ claudeAiOauth: o }));
const vaultOf = (w, name) => JSON.parse(w.vault.entries.get(`account/${name}`));
const reg = (w) => loadRegistry(w.dataDir);
const snapshot = (w) => [...w.vault.entries.entries()].map(([k, v]) => `${k}=${v}`).sort();

function stubWorld(t, cfg, opts = {}) {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const env = { ...process.env, AM_LOGIN_LOG: log, AM_LOGIN_STUB: JSON.stringify(cfg) };
  const w = world(t, { claude: { command: process.execPath, args: [STUB] }, env, ...opts });
  return { ...w, log };
}

test('swap then a renewal that drops accountUuid: still known, sync-back saves to that account with accountUuid', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  assert.equal(reg(w).live.accountUuid, 'uuid-orders');
  assert.equal(reg(w).live.oauthAccount, 'uuid-ryan');
  setCreds(w, bare(rotated(ORDERS))); // .claude.json still lags on ryan
  assert.equal(w.m.liveReason(), null);
  assert.equal(w.m.activeName(), 'orders');
  assert.equal(await w.m.syncBack(), true);
  assert.equal(vaultOf(w, 'orders').accountUuid, 'uuid-orders');
  assert.match(vaultOf(w, 'orders').refreshToken, /-r1$/);
  assert.match(vaultOf(w, 'ryan').refreshToken, /FAKE-uuid-ryan-refresh$/, 'ryan untouched');
});

test('a fresh login with its own accountUuid is recorded live even after a stale lastSwitch (registered account)', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders'); // lastSwitch.to = orders
  setCreds(w, rotated(RYAN, 2)); // manual /login as ryan
  await w.m.syncBack();
  assert.equal(reg(w).live.accountUuid, 'uuid-ryan');
  assert.match(vaultOf(w, 'ryan').refreshToken, /-r2$/);
  setCreds(w, bare(rotated(RYAN, 3))); // then a renewal drops the id
  assert.equal(w.m.liveReason(), null, 'a stale lastSwitch no longer makes it uncertain');
  assert.equal(await w.m.syncBack(), true);
  assert.match(vaultOf(w, 'ryan').refreshToken, /-r3$/);
  assert.equal(vaultOf(w, 'ryan').accountUuid, 'uuid-ryan');
});

test('a manual login as an unregistered account is carried; its renewals save nothing and misfile nothing', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  const before = snapshot(w);
  setCreds(w, NEW);
  setOa(w, 'uuid-new');
  assert.equal(await w.m.syncBack(), false);
  assert.equal(reg(w).live.accountUuid, 'uuid-new');
  setCreds(w, bare(rotated(NEW)));
  assert.equal(w.m.liveReason(), null);
  assert.equal(w.m.activeName(), null);
  assert.equal(await w.m.syncBack(), false);
  assert.deepEqual(snapshot(w), before);
});

test("a token with another account's uuid is saved under that uuid only", async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, rotated(LAB, 4));
  assert.equal(await w.m.syncBack(), true);
  assert.match(vaultOf(w, 'lab').refreshToken, /-r4$/);
  assert.equal(reg(w).live.accountUuid, 'uuid-lab');
  assert.match(vaultOf(w, 'orders').refreshToken, /FAKE-uuid-orders-refresh$/);
});

test('.claude.json changed to another account since recording: uncertain everywhere, nothing saved or spawned', async (t) => {
  const w = stubWorld(t, {}, { accounts: three, live: RYAN, usage });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, bare(rotated(ORDERS)));
  setOa(w, 'uuid-lab'); // someone signed in as lab in another window
  assert.match(w.m.liveReason(), /names uuid-lab@x\.com.*"orders"/);
  const before = snapshot(w);
  assert.equal(await w.m.syncBack(), false);
  assert.deepEqual(snapshot(w), before);
  await assert.rejects(w.m.use('lab'), /cannot tell which account the live login is/);
  assert.equal(w.m.recordReading(null, { five_hour: win(5, R + 99999), seven_day: null }), null);
  const r = await w.m.handleLimit({ runAccount: 'orders', ...hit });
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(r.error, /cannot tell which account the live login is/);
  assert.deepEqual(readLog(w.log), [], 'no claude process was started');
});

test('confirm then flip back to the old account: uncertain', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, bare(rotated(ORDERS)));
  setOa(w, 'uuid-orders'); // Claude Code caught up
  await w.m.syncBack();
  assert.equal(reg(w).live.oauthAccount, 'uuid-orders');
  assert.equal(w.m.liveReason(), null);
  setOa(w, 'uuid-ryan'); // flips back: no longer the lag
  assert.match(w.m.liveReason(), /\.claude\.json now names/);
});

test('a registry without live keeps the older lastSwitch rule', async (t) => {
  const w = world(t, { accounts: three });
  const r0 = reg(w);
  r0.lastSwitch = { from: 'ryan', to: 'orders', at, reason: 'x' };
  delete r0.live;
  fs.writeFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), JSON.stringify(r0));
  setCreds(w, bare(ORDERS));
  setOa(w, 'uuid-ryan');
  assert.match(w.m.liveReason(), /last switched to "orders"/);
  setOa(w, 'uuid-orders');
  assert.equal(w.m.liveReason(), null);
  assert.equal(w.m.activeName(), 'orders');
  assert.equal(reg(w).live, null);
});

test("liveIdentity: the creds' own accountUuid wins over a carried one", (t) => {
  const w = world(t, { accounts: three, live: LAB });
  const carried = { accountUuid: 'uuid-ryan', oauthAccount: null };
  const id = liveIdentity({ home: w.home, claudeJson: path.join(w.home, '.claude.json'), reg: { accounts: {}, live: carried } });
  assert.equal(id.accountUuid, 'uuid-lab');
});

test('handleLimit: a dead saved login is marked and skipped; the next best is used', async (t) => {
  const w = stubWorld(t, { per: { 'uuid-orders': { write: 'delete', exit: 1 } } }, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit(hit);
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'lab', switched: true, duplicate: false });
  assert.equal(reg(w).accounts.orders.savedAt, null);
  assert.equal(reg(w).accounts.orders.refreshExpiresAt, null);
  assert.equal(w.m.activeName(), 'lab');
  assert.match(JSON.parse(fs.readFileSync(w.file, 'utf8')).claudeAiOauth.refreshToken, /-rotated$/, 'the refreshed login is the one swapped in');
});

test('handleLimit: a failed check that is not a dead login skips without marking', async (t) => {
  const w = stubWorld(t, { per: { 'uuid-orders': { write: 'none' } } }, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit(hit);
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'lab', switched: true, duplicate: false });
  assert.ok(reg(w).accounts.orders.savedAt, 'orders stays saved');
});

test('handleLimit: every candidate fails -> next null with an error listing each', async (t) => {
  const w = stubWorld(t, { write: 'delete' }, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit(hit);
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(r.error, /orders: The saved login no longer works.*lab: The saved login no longer works/);
  assert.equal(w.m.activeName(), 'ryan');
});

test('handleLimit: nobody available and no check failed -> no error, as before', async (t) => {
  const w = stubWorld(t, {}, { accounts: { ryan: RYAN }, live: RYAN });
  assert.deepEqual(await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' }), { hitAccount: 'ryan', next: null, switched: false, duplicate: false });
});

test('handleLimit: a concurrent call already switched the login -> already live, no second switch', async (t) => {
  const labFirst = { orders: usage.lab, lab: usage.orders }; // lab is the best, orders next
  const w = stubWorld(t, {}, { accounts: three, live: RYAN, usage: labFirst });
  const before = reg(w).lastSwitch;
  const vaultBefore = snapshot(w);
  let second;
  await withLock(w.dataDir, async () => {
    second = w.m.handleLimit(hit); // computes active=ryan, next=lab, then waits for the lock inside refresh
    setCreds(w, LAB); // the other call's switch lands
  });
  const r = await second;
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'lab', switched: false, duplicate: false });
  assert.equal(JSON.parse(fs.readFileSync(w.file, 'utf8')).claudeAiOauth.accountUuid, 'uuid-lab');
  assert.deepEqual(reg(w).lastSwitch, before);
  assert.deepEqual(snapshot(w), vaultBefore, 'orders was never refreshed');
  assert.equal(readLog(w.log).length, 0, 'no login check ran');
});

test('refresh(): a dead login is marked and rethrows the exact sentence; use() then refuses it', async (t) => {
  const w = stubWorld(t, { write: 'delete', exit: 1 }, { accounts: three, live: RYAN });
  await assert.rejects(w.m.refresh('lab'), (e) => e.message === DEAD_LOGIN && e.message === 'The saved login no longer works: sign in again (Add account, same name).');
  const a = reg(w).accounts.lab;
  assert.equal(a.savedAt, null);
  assert.equal(a.refreshExpiresAt, null);
  assert.equal(w.m.list().find((x) => x.name === 'lab').saved, false);
  await assert.rejects(w.m.use('lab'), /no saved login for "lab"/);
  assert.equal(w.m.activeName(), 'ryan');
});

test('refresh(): not-refreshed (no dead login) does not mark', async (t) => {
  const w = stubWorld(t, { write: 'none' }, { accounts: three, live: RYAN });
  await assert.rejects(w.m.refresh('lab'), /did not refresh the login/);
  assert.ok(reg(w).accounts.lab.savedAt);
});

test('refresh(): refuses while the live account is uncertain', async (t) => {
  const w = stubWorld(t, {}, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, bare(ORDERS));
  setOa(w, 'uuid-lab');
  await assert.rejects(w.m.refresh('lab'), /cannot tell which account the live login is/);
  assert.deepEqual(readLog(w.log), []);
});

test('carried account with a recorded oauthAccount, then .claude.json missing or corrupt: uncertain, nothing saved', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, bare(rotated(ORDERS)));
  const before = snapshot(w);
  for (const text of [null, '{"numStartups": 3, "oauthAcc']) {
    const file = path.join(w.home, '.claude.json');
    if (text == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, text);
    assert.ok(w.m.liveReason(), 'unreadable .claude.json is uncertain');
    assert.equal(await w.m.syncBack(), false);
    assert.deepEqual(snapshot(w), before);
  }
});

test('carried account recorded with no oauthAccount and still no .claude.json: identified', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  await w.m.use('orders'); // no .claude.json when recorded
  assert.equal(reg(w).live.oauthAccount, null);
  setCreds(w, bare(rotated(ORDERS)));
  assert.equal(w.m.liveReason(), null);
  assert.equal(w.m.activeName(), 'orders');
  assert.equal(await w.m.syncBack(), true);
});

test('handleLimit: a non-dead failed check is not re-run for 10 minutes, then is checked again', async (t) => {
  const w = stubWorld(t, { write: 'none' }, { accounts: three, live: RYAN, usage });
  const r1 = await w.m.handleLimit(hit);
  const spawned = readLog(w.log).length;
  assert.ok(spawned >= 1);
  assert.equal(r1.next, null);
  assert.match(r1.error, /no saved login could be used/);
  const r2 = await w.m.handleLimit(hit);
  assert.equal(readLog(w.log).length, spawned, 'the second event spawned nothing');
  assert.equal(r2.next, null);
  assert.equal(r2.switched, false);
  assert.match(r2.error, /no saved login could be used \(orders: .*lab: /);
  w.time.now += 10 * 60_000 + 1;
  await w.m.handleLimit(hit);
  assert.equal(readLog(w.log).length, spawned * 2, 'checked again after 10 minutes');
});
