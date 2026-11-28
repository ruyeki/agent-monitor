// Pre-switch check (AC4) and dead-login handling (AC4/AC5), with a stub claude (spawn mocked by the stub). Fake logins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { saveRegistry } from '../src/accounts/state.js';
import { fvWorld, oauth, U, NOW, DAY } from './holdout-accounts-live-helpers.js';
import { win, secs } from './accounts-helpers.js';

const RYAN = oauth(U('ryan'));
const ORDERS = oauth(U('orders'));
const LAB = oauth(U('lab'));
const three = { ryan: RYAN, orders: ORDERS, lab: LAB };
const R = secs(NOW + 2 * 3600_000);
const at = new Date(NOW).toISOString();
// orders has the most left, lab next
const usage = { orders: { reading: { five_hour: win(10, R + 3600), seven_day: null } }, lab: { reading: { five_hour: win(50, R + 7200), seven_day: null } } };
const hit = () => ({ at, resetsAt: R, source: 'stopfailure' });
const DEAD = 'The saved login no longer works: sign in again (Add account, same name).';
const liveRefresh = (w) => JSON.parse(w.live()).claudeAiOauth.refreshToken;

test('AC4 the target is refreshed before the switch and the refreshed login goes live and into the vault', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit(hit());
  assert.equal(r.next, 'orders');
  assert.equal(r.switched, true);
  assert.equal(r.error, undefined);
  assert.deepEqual(w.calls().map((c) => c.uuid), [U('orders')], 'only the target is refreshed, never the live account');
  assert.equal(liveRefresh(w), `${ORDERS.refreshToken}-rot`);
  assert.equal(w.vtok('orders'), `${ORDERS.refreshToken}-rot`);
  assert.equal(w.m.activeName(), 'orders');
});

test('AC4 a dead login is marked and skipped; the next best account is tried and used', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ dead: [U('orders')] });
  const r = await w.m.handleLimit(hit());
  assert.equal(r.next, 'lab');
  assert.equal(r.switched, true);
  assert.deepEqual(w.calls().map((c) => c.uuid), [U('orders'), U('lab')]);
  assert.equal(liveRefresh(w), `${LAB.refreshToken}-rot`);
  const row = w.m.list().find((a) => a.name === 'orders');
  assert.equal(row.saved, false);
  assert.equal(row.available, false);
  assert.equal(w.reg().accounts.orders.savedAt, null);
  assert.equal(w.reg().accounts.orders.refreshExpiresAt, null);
});

test('AC4 every candidate dead: nothing switches, the live login is untouched, the error names each account', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ dead: [U('orders'), U('lab')] });
  const before = w.live();
  const r = await w.m.handleLimit(hit());
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.equal(r.hitAccount, 'ryan');
  assert.match(r.error, /orders/);
  assert.match(r.error, /lab/);
  assert.equal(w.live(), before);
  assert.equal(w.m.activeName(), 'ryan');
});

test('AC4 a failure that is not a dead login (login came back unrefreshed) skips the account but does not mark it', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ stuck: [U('orders')] });
  const savedAt = w.reg().accounts.orders.savedAt;
  const r = await w.m.handleLimit(hit());
  assert.equal(r.next, 'lab');
  assert.equal(r.switched, true);
  assert.equal(w.reg().accounts.orders.savedAt, savedAt, 'still marked as saved');
  assert.equal(w.m.list().find((a) => a.name === 'orders').saved, true);
});

test('AC4 only failures that are not dead: none left -> error, no switch, nothing marked', async (t) => {
  const w = fvWorld(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN, usage });
  w.cfg({ stuck: [U('orders')] });
  const r = await w.m.handleLimit(hit());
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(r.error, /orders/);
  assert.equal(w.m.list().find((a) => a.name === 'orders').saved, true);
  assert.equal(w.m.activeName(), 'ryan');
});

test('AC4 nobody else available (all out): same shape as today, no error key, no process started', async (t) => {
  const limited = { lab: { reading: null, limit: { at, resetsAt: secs(NOW + DAY) } } };
  const w = fvWorld(t, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN, usage: limited });
  const r = await w.m.handleLimit(hit());
  assert.deepEqual(r, { hitAccount: 'ryan', next: null, switched: false, duplicate: false });
  assert.deepEqual(w.calls(), []);
});

test('AC4 live account uncertain: the swap error comes back and no account is refreshed (it could be the live one)', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  const reg = w.reg();
  saveRegistry(w.dataDir, { ...reg, live: { accountUuid: U('lab'), oauthAccount: U('ryan'), organizationUuid: `org-${U('lab')}`, at } });
  w.writeOa('orders'); // moved on since it was recorded
  const { accountUuid, organizationUuid, ...bareRyan } = RYAN;
  fs.writeFileSync(w.file, JSON.stringify({ claudeAiOauth: bareRyan }));
  const r = await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure', runAccount: 'ryan' });
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(r.error, /cannot tell which account/);
  assert.deepEqual(w.calls(), []);
  assert.equal(w.reg().accounts.orders.savedAt, reg.accounts.orders.savedAt);
});

test('AC5 refresh of a dead login throws the plain sentence and marks the account as needing sign-in', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ dead: [U('lab')] });
  await assert.rejects(w.m.refresh('lab'), (e) => e.message === DEAD);
  const row = w.m.list().find((a) => a.name === 'lab');
  assert.equal(row.saved, false);
  assert.equal(row.available, false);
  assert.equal(w.reg().accounts.lab.savedAt, null);
  assert.equal(w.reg().accounts.lab.refreshExpiresAt, null);
});

test('AC5 a login that came back as another account is also a dead login', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ other: [U('lab')] });
  await assert.rejects(w.m.refresh('lab'), (e) => e.message === DEAD);
  assert.equal(w.reg().accounts.lab.savedAt, null);
});

test('AC4/5 a marked account cannot be switched to (accounts use) and the periodic refresh leaves it alone', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ dead: [U('lab')] });
  await assert.rejects(w.m.refresh('lab'));
  const liveBefore = w.live();
  await assert.rejects(w.m.use('lab'), /no saved login/);
  assert.equal(w.live(), liveBefore, 'the live login is untouched');
  const out = await w.m.refreshDue();
  assert.equal(out.find((x) => x.name === 'lab'), undefined);
  assert.equal(w.calls().filter((c) => c.uuid === U('lab')).length, 1, 'only the first, failing refresh ran');
});

test('AC5 "did not refresh the login" keeps its text and does not mark the account', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ stuck: [U('lab')] });
  await assert.rejects(w.m.refresh('lab'), /did not refresh the login/);
  assert.equal(w.m.list().find((a) => a.name === 'lab').saved, true);
});

test('the old "did not return a login for this account" text is gone', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  w.cfg({ dead: [U('lab')] });
  await assert.rejects(w.m.refresh('lab'), (e) => !/did not return a login/.test(e.message));
});

test('refresh refuses while the live account is uncertain, and starts nothing', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  saveRegistry(w.dataDir, { ...w.reg(), live: { accountUuid: U('lab'), oauthAccount: U('ryan'), organizationUuid: 'org-x', at } });
  w.writeOa('orders');
  const { accountUuid, organizationUuid, ...bareRyan } = RYAN;
  fs.writeFileSync(w.file, JSON.stringify({ claudeAiOauth: bareRyan }));
  await assert.rejects(w.m.refresh('orders'));
  assert.deepEqual(w.calls(), []);
});

test('refresh of the live account is still refused', async (t) => {
  const w = fvWorld(t, { accounts: three, live: RYAN, usage });
  await assert.rejects(w.m.refresh('ryan'), /is the live login/);
  assert.deepEqual(w.calls(), []);
});
