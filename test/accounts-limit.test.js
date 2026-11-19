import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadRegistry, readUsage } from '../src/accounts/state.js';
import { LIMIT_FALLBACK_MS } from '../src/accounts/usage.js';
import { memoryVault } from '../src/accounts/vault.js';
import { world, oauth, win, secs, NOW } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const LAB = oauth('uuid-lab');
const R = secs(NOW + 2 * 3600_000); // a reset time
const at = new Date(NOW).toISOString();
const three = { ryan: RYAN, orders: ORDERS, lab: LAB };
// orders has the most left, lab next
const usage = { orders: { reading: { five_hour: win(10, R + 3600), seven_day: null } }, lab: { reading: { five_hour: win(50, R + 7200), seven_day: null } } };

test('handleLimit: no accounts -> next null', async (t) => {
  const w = world(t, { live: RYAN });
  assert.deepEqual(await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' }), { next: null });
});

test('handleLimit: the active account hits -> limit recorded, switches to the most left', async (t) => {
  const w = world(t, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit({ at, resetsAt: new Date(R * 1000).toISOString(), source: 'stopfailure' });
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'orders', switched: true, duplicate: false });
  assert.deepEqual(readUsage(w.dataDir, 'ryan').limit, { at, resetsAt: R });
  assert.equal(w.m.activeName(), 'orders');
  assert.equal(loadRegistry(w.dataDir).lastSwitch.reason, 'stopfailure limit on ryan');
  assert.equal(w.m.pickBest(), 'orders', 'ryan is limited now');
  assert.equal(w.m.pickBest({ exclude: ['orders'] }), 'lab');
});

test('handleLimit: a hit whose reset time belongs to another account is a duplicate; the active one stays', async (t) => {
  const w = world(t, { accounts: three, live: LAB, usage });
  const r = await w.m.handleLimit({ at, resetsAt: R + 3600, source: 'stopfailure' }); // orders' stored 5h reset
  assert.deepEqual(r, { hitAccount: 'orders', next: 'lab', switched: false, duplicate: true });
  assert.equal(readUsage(w.dataDir, 'orders').limit.resetsAt, R + 3600);
  assert.equal(w.m.activeName(), 'lab');
});

test('handleLimit: no reset time within 120 s of a switch is a duplicate of the switched-from account', async (t) => {
  const w = world(t, { accounts: three, live: RYAN, usage });
  await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' }); // ryan -> orders
  w.time.now = NOW + 60_000;
  const r = await w.m.handleLimit({ at: new Date(w.time.now).toISOString(), resetsAt: null, source: 'stopfailure' });
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'orders', switched: false, duplicate: true });
  assert.equal(w.m.activeName(), 'orders');
  assert.deepEqual(readUsage(w.dataDir, 'ryan').limit, { at, resetsAt: R }, 'the stored reset time is kept');

  w.time.now = NOW + 180_000; // past the window: a real hit on orders
  const r2 = await w.m.handleLimit({ at: new Date(w.time.now).toISOString(), resetsAt: null, source: 'stopfailure' });
  assert.deepEqual(r2, { hitAccount: 'orders', next: 'lab', switched: true, duplicate: false });
  assert.equal(readUsage(w.dataDir, 'orders').limit.resetsAt, null);
  assert.equal(w.m.list().find((a) => a.name === 'orders').limitedUntil, NOW + 180_000 + LIMIT_FALLBACK_MS);
});

test('handleLimit: a duplicate while the active account is out picks the best other one', async (t) => {
  const w = world(t, { accounts: three, live: LAB, usage: { ...usage, lab: { reading: { five_hour: win(100, R + 7200) } } } });
  const r = await w.m.handleLimit({ at, resetsAt: R + 3600, source: 'transcript' });
  assert.deepEqual(r, { hitAccount: 'orders', next: 'ryan', switched: true, duplicate: true });
  assert.equal(w.m.activeName(), 'ryan');
});

test('handleLimit: a known run account is never a duplicate and is excluded', async (t) => {
  const w = world(t, { accounts: three, live: LAB, usage: { ...usage, ryan: { reading: { five_hour: win(70, R) } } } });
  const r = await w.m.handleLimit({ runAccount: 'orders', at, resetsAt: null, source: 'stopfailure' });
  assert.deepEqual(r, { hitAccount: 'orders', next: 'lab', switched: false, duplicate: false }, 'lab is already live');
  const r2 = await w.m.handleLimit({ runAccount: 'lab', at, resetsAt: R, source: 'stopfailure' });
  assert.deepEqual(r2, { hitAccount: 'lab', next: 'ryan', switched: true, duplicate: false });
});

test('handleLimit: every account out -> next null, nothing switches', async (t) => {
  const full = { reading: { five_hour: win(100, R) } };
  const w = world(t, { accounts: three, live: RYAN, usage: { orders: full, lab: full } });
  const before = w.live();
  assert.deepEqual(await w.m.handleLimit({ at, resetsAt: R + 5 }), { hitAccount: 'ryan', next: null, switched: false, duplicate: false });
  assert.equal(w.live(), before);
});

test('handleLimit: a failed swap returns next null with the error; never throws', async (t) => {
  const vault = memoryVault();
  const w = world(t, { accounts: three, live: RYAN, usage, vault });
  const before = w.live();
  vault.setMany = async () => { throw new Error('vault: CredWriteW failed (error 5) on x'); };
  const r = await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' });
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.equal(r.hitAccount, 'ryan');
  assert.match(r.error, /CredWriteW/);
  assert.equal(w.live(), before);

  fs.writeFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), '{not json');
  const r2 = await w.m.handleLimit({ at, resetsAt: R });
  assert.equal(r2.next, null);
  assert.ok(r2.error);
  assert.equal(w.m.pickBest(), null);
  assert.equal(w.m.hasAccounts(), false);
});

test('recordRateLimit: allowed records the windows, rejected also records a limit; never throws', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  const info = { status: 'allowed', resetsAt: R, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: R }, seven_day: { utilization: 0.37, resetsAt: R + 86400 } } };
  w.m.recordRateLimit('lab', info);
  assert.deepEqual(readUsage(w.dataDir, 'lab').reading.five_hour, { used_percentage: 15, resets_at: R });
  assert.equal(readUsage(w.dataDir, 'lab').limit, null);
  w.m.recordRateLimit('lab', { ...info, status: 'rejected' });
  assert.deepEqual(readUsage(w.dataDir, 'lab').limit, { at, resetsAt: R });
  assert.doesNotThrow(() => w.m.recordRateLimit('lab', 'junk'));
  assert.doesNotThrow(() => w.m.recordRateLimit('nobody', info));
  assert.equal(w.m.recordReading('nobody', { five_hour: win(1, R) }), null);
  assert.equal(w.m.recordLimit('nobody', { at }), false);
});

test('handleLimit: null and undefined never throw', async (t) => {
  const none = world(t, { live: RYAN });
  assert.deepEqual(await none.m.handleLimit(null), { next: null });
  assert.deepEqual(await none.m.handleLimit(undefined), { next: null });
  const w = world(t, { accounts: three, live: RYAN, usage });
  const r = await w.m.handleLimit(null);
  assert.ok(r && typeof r === 'object' && !('error' in r), JSON.stringify(r));
  await assert.doesNotReject(w.m.handleLimit(undefined));
});

test('handleLimit: a live login that is not a saved account -> next null with the save-it-first error', async (t) => {
  const w = world(t, { accounts: { orders: ORDERS, lab: LAB }, live: RYAN, usage });
  const before = w.live();
  const r = await w.m.handleLimit({ runAccount: 'orders', at, resetsAt: R });
  assert.equal(r.next, null);
  assert.equal(r.switched, false);
  assert.match(r.error, /the live login is not a saved account; save it first/);
  assert.equal(w.live(), before);
});

test('handleLimit: waits for a lock held by a refresh instead of failing', async (t) => {
  const w = world(t, { accounts: three, live: RYAN, usage, limitWaitMs: 5000 });
  const lock = path.join(w.dataDir, 'accounts', '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, 'held');
  setTimeout(() => fs.rmSync(lock, { force: true }), 400);
  const r = await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' });
  assert.equal(r.error, undefined);
  assert.equal(r.next, 'orders');
  assert.equal(r.switched, true);
});

test('handleLimit: the default lock wait outlasts a 120 s refresh; the plain use() wait does not', async () => {
  const src = fs.readFileSync(new URL('../src/accounts/index.js', import.meta.url), 'utf8');
  const state = fs.readFileSync(new URL('../src/accounts/state.js', import.meta.url), 'utf8');
  assert.ok(Number(/const LIMIT_WAIT_MS = ([\d_]+)/.exec(src)[1].replaceAll('_', '')) >= 150_000);
  assert.ok(Number(/const LOCK_WAIT_MS = ([\d_]+)/.exec(state)[1].replaceAll('_', '')) <= 15_000);
});
