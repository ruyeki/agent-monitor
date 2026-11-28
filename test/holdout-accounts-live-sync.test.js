// Sync-back across swap / manual login / renewal / foreign token, through createAccounts and recordWindows only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccounts } from '../src/accounts/index.js';
import { recordWindows } from '../src/accounts/record.js';
import { fvWorld, oauth, renewed, U, NOW } from './holdout-accounts-live-helpers.js';

const RYAN = oauth(U('ryan'));
const LAB = oauth(U('lab'));
const ORDERS = oauth(U('orders'));
const three = { ryan: RYAN, lab: LAB, orders: ORDERS };
const reading = () => ({ five_hour: { used_percentage: 30, resets_at: Math.floor(NOW / 1000) + 3600 }, seven_day: null });

async function swapped(t) {
  const w = fvWorld(t, { accounts: three, live: RYAN });
  w.writeOa('ryan');
  await w.m.use('lab');
  return w;
}

test('AC2 swap then renewal: the renewed token is saved to the swapped-to account, not the old one, and no warning', async (t) => {
  const w = await swapped(t);
  const ryanBefore = w.vtok('ryan');
  w.writeLive(renewed(LAB), true); // Claude Code renews, drops accountUuid; .claude.json still names ryan
  w.time.now = NOW + 40 * 3600_000;
  assert.equal(await w.m.syncBack(), true);
  assert.equal(w.vtok('lab'), `${LAB.refreshToken}-renew`);
  assert.equal(w.vtok('ryan'), ryanBefore);
  assert.equal(w.m.activeName(), 'lab');
  assert.equal(w.m.liveReason(), null);
});

test('AC2 a second renewal is saved too (the carried account survives repeated renewals)', async (t) => {
  const w = await swapped(t);
  w.writeLive(renewed(LAB, 'r1'), true);
  await w.m.syncBack();
  w.writeLive(renewed(LAB, 'r2'), true);
  await w.m.syncBack();
  assert.equal(w.vtok('lab'), `${LAB.refreshToken}-r2`);
  assert.equal(w.m.liveReason(), null);
});

test('AC1 manual login then renewal: saved to the account it names, stale lastSwitch never makes it uncertain', async (t) => {
  const w = await swapped(t); // lastSwitch is ryan -> lab
  const labBefore = w.vtok('lab');
  w.writeLive(renewed(ORDERS, 'manual')); // /login as orders: carries accountUuid; .claude.json still ryan (lag)
  await w.m.syncBack();
  assert.equal(w.vtok('orders'), `${ORDERS.refreshToken}-manual`);
  assert.equal(w.vtok('lab'), labBefore, 'the manual login must not be filed under lab');
  w.writeLive(renewed(ORDERS, 'next'), true);
  await w.m.syncBack();
  assert.equal(w.vtok('orders'), `${ORDERS.refreshToken}-next`);
  assert.equal(w.vtok('lab'), labBefore);
  assert.equal(w.m.activeName(), 'orders');
  assert.equal(w.m.liveReason(), null);
});

test('AC1 the recorded manual login survives a restart (a new manager on the same data still identifies it)', async (t) => {
  const w = await swapped(t);
  w.writeLive(renewed(ORDERS, 'manual'));
  await w.m.syncBack();
  const m2 = createAccounts({ dataDir: w.dataDir, home: w.home, vault: w.vault, clock: () => w.time.now });
  t.after(() => m2.close());
  w.writeLive(renewed(ORDERS, 'later'), true);
  assert.equal(m2.activeName(), 'orders');
  assert.equal(await m2.syncBack(), true);
  assert.equal(w.vtok('orders'), `${ORDERS.refreshToken}-later`);
});

test('AC1 manual login as an account nobody saved: no vault entry changes, a later renewal is not filed under lab', async (t) => {
  const w = await swapped(t);
  const snap = w.vaultSnap();
  const STR = oauth('uuid-stranger');
  w.writeLive(STR);
  await w.m.syncBack();
  w.writeLive(renewed(STR, 'renew'), true);
  await w.m.syncBack();
  assert.equal(w.vaultSnap(), snap);
  assert.equal(w.m.activeName(), null);
  assert.equal(w.m.liveReason(), null, 'it is known, just not a saved account');
});

test('AC3 foreign token: .claude.json now names another account -> stays uncertain, saves nothing, refuses to switch', async (t) => {
  const w = await swapped(t);
  const snap = w.vaultSnap();
  w.writeOa('orders'); // changed since the swap, not explained by it
  w.writeLive(renewed(LAB, 'foreign'), true);
  await w.m.syncBack();
  assert.equal(w.vaultSnap(), snap, 'no vault entry may change');
  assert.equal(w.m.activeName(), null);
  assert.ok(w.m.liveReason());
  await assert.rejects(w.m.use('ryan'), /cannot tell which account/);
});

test('AC3 statusline recorder: an uncertain live login gets no reading filed under the carried account', async (t) => {
  const w = await swapped(t);
  w.writeOa('orders');
  w.writeLive(renewed(LAB, 'foreign'), true);
  const r = recordWindows({ dataDir: w.dataDir, home: w.home, claudeJson: w.claudeJson, reading: reading(), now: NOW });
  assert.notEqual(r, 'lab');
});

test('swap records the new live account: a statusline reading goes to the swapped-to account after a renewal', async (t) => {
  const w = await swapped(t);
  w.writeLive(renewed(LAB), true); // no accountUuid, .claude.json lags
  assert.equal(recordWindows({ dataDir: w.dataDir, home: w.home, claudeJson: w.claudeJson, reading: reading(), now: NOW }), 'lab');
});
