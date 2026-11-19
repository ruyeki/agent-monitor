// AC2 + selection: usage maths, pickBest, limits, recording. Behaviour only through the named contract.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, reading, nm, NOW, H, sec, iso, readUsageFile, readRegistry, filesWithTokens } from './holdout-accounts-helpers.js';

const setup = (t, accounts = ['ana', 'bob', 'cyd']) => world(t, { accounts });

test('pickBest: most usage left wins; no reading counts as fully available', async (t) => {
  const w = await setup(t);
  w.mgr.recordReading('ana', reading(30, 60)); // left 40
  w.mgr.recordReading('bob', reading(10, 20)); // left 80
  assert.equal(nm(w.mgr.pickBest({})), 'cyd'); // no reading = 100
  assert.equal(nm(w.mgr.pickBest({ exclude: ['cyd'] })), 'bob');
  assert.equal(nm(w.mgr.pickBest({ exclude: ['cyd', 'bob'] })), 'ana');
  assert.equal(nm(w.mgr.pickBest({ exclude: ['cyd', 'bob', 'ana'] })), null);
});

test('pickBest: a tie goes to the name that sorts first', async (t) => {
  const w = await setup(t);
  w.mgr.recordReading('ana', reading(50, 10));
  assert.equal(nm(w.mgr.pickBest({})), 'bob'); // bob and cyd both 100
  w.mgr.recordReading('bob', reading(0, 0));
  assert.equal(nm(w.mgr.pickBest({})), 'bob');
});

test('usage left is 100 minus the HIGHER of the two windows', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  w.mgr.recordReading('ana', reading(5, 90)); // left 10
  w.mgr.recordReading('bob', reading(60, 60)); // left 40
  assert.equal(nm(w.mgr.pickBest({})), 'bob');
  w.mgr.recordReading('ana', reading(5, 20)); // left 80
  assert.equal(nm(w.mgr.pickBest({})), 'ana');
});

test('a window whose resets_at has passed counts as 0% used', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  // ana: 5h at 95% but that window reset 100 s ago; 7d at 10% -> left 90. bob: left 50.
  w.mgr.recordReading('ana', reading(95, 10, { fiveReset: sec(NOW - 100e3) }));
  w.mgr.recordReading('bob', reading(50, 0));
  assert.equal(nm(w.mgr.pickBest({})), 'ana');
  // both windows expired -> fully fresh even at 100%
  w.mgr.recordReading('ana', reading(100, 100, { fiveReset: sec(NOW - 5e3), sevenReset: sec(NOW - 5e3) }));
  assert.equal(nm(w.mgr.pickBest({ exclude: ['bob'] })), 'ana');
  // the boundary: resets_at exactly now is already reset
  w.mgr.recordReading('ana', reading(100, 0, { fiveReset: sec(NOW) }));
  assert.equal(nm(w.mgr.pickBest({ exclude: ['bob'] })), 'ana');
  // and the window becomes fresh as the clock moves past it
  w.mgr.recordReading('ana', reading(100, 0, { fiveReset: sec(NOW + 60e3) }));
  assert.equal(nm(w.mgr.pickBest({ exclude: ['bob'] })), null); // 0 left = unavailable
  w.state.now = NOW + 120e3;
  assert.equal(nm(w.mgr.pickBest({ exclude: ['bob'] })), 'ana');
});

test('percentages are clamped to 0..100; 0 left is unavailable; a missing window counts as 0', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  w.mgr.recordReading('ana', reading(150, 0)); // clamped to 100 -> left 0 -> unavailable
  w.mgr.recordReading('bob', reading(99, 99)); // left 1, still available
  assert.equal(nm(w.mgr.pickBest({})), 'bob');
  w.mgr.recordReading('ana', reading(-20, null)); // negative -> 0, 7d absent -> 0
  assert.equal(nm(w.mgr.pickBest({})), 'ana');
  w.mgr.recordReading('ana', reading(null, 40)); // 5h absent
  w.mgr.recordReading('bob', reading(70, null));
  assert.equal(nm(w.mgr.pickBest({})), 'ana');
});

test('a recorded limit takes the account out until its reset time, then it is back', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  w.mgr.recordLimit('bob', { at: iso(NOW - H), resetsAt: iso(NOW + 2 * H) });
  assert.equal(nm(w.mgr.pickBest({})), 'ana');
  assert.equal(nm(w.mgr.pickBest({ exclude: ['ana'] })), null);
  w.state.now = NOW + 2 * H + 1000;
  assert.equal(nm(w.mgr.pickBest({ exclude: ['ana'] })), 'bob');
});

test('a limit with no reset time lasts 5 hours from the hit; a reset time not after the hit also means 5 hours', async (t) => {
  const w = await setup(t, ['ana', 'bob', 'cyd', 'dee']);
  const only = (n) => nm(w.mgr.pickBest({ exclude: ['ana', 'bob', 'cyd', 'dee'].filter((x) => x !== n) }));
  w.mgr.recordLimit('bob', { at: iso(NOW - 4 * H), resetsAt: null });
  assert.equal(only('bob'), null, 'still limited 4h in');
  w.mgr.recordLimit('cyd', { at: iso(NOW - 6 * H), resetsAt: null });
  assert.equal(only('cyd'), 'cyd', 'free 6h in');
  w.mgr.recordLimit('dee', { at: iso(NOW - H), resetsAt: iso(NOW - 2 * H) }); // reset before the hit: nonsense -> at + 5h
  assert.equal(only('dee'), null);
});

test('recordReading and recordRateLimit persist per account without secrets, and never throw on junk', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  w.mgr.recordReading('ana', reading(40, 70));
  const u = readUsageFile(w.dataDir, 'ana');
  assert.equal(u.reading.five_hour.used_percentage, 40);
  assert.equal(u.reading.seven_day.used_percentage, 70);
  assert.equal(u.reading.five_hour.resets_at, sec(NOW + 3 * H));
  // Claude's stream-json rate_limit_info: utilization is a 0..1 fraction
  w.mgr.recordRateLimit('bob', { status: 'allowed', resetsAt: sec(NOW + 3 * H), rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: sec(NOW + 3 * H) }, seven_day: { utilization: 0.37, resetsAt: sec(NOW + 48 * H) } } });
  const b = readUsageFile(w.dataDir, 'bob');
  assert.ok(Math.abs(b.reading.five_hour.used_percentage - 15) < 0.01);
  assert.ok(Math.abs(b.reading.seven_day.used_percentage - 37) < 0.01);
  for (const junk of [undefined, null, 'x', 42, {}, { unifiedWindows: 5 }, { unifiedWindows: { five_hour: { utilization: 'NaN' } } }]) {
    assert.doesNotThrow(() => w.mgr.recordRateLimit('bob', junk));
  }
  assert.doesNotThrow(() => w.mgr.recordRateLimit('nobody', { unifiedWindows: {} }));
  assert.deepEqual(filesWithTokens(w.dataDir), [], 'no token values in the data dir');
});

test('registry holds names, uuid, email and no secrets; remove() forgets an account everywhere', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  const reg = readRegistry(w.dataDir);
  assert.deepEqual(Object.keys(reg.accounts).sort(), ['ana', 'bob']);
  assert.equal(reg.accounts.ana.accountUuid, 'uuid-ana');
  assert.equal(reg.accounts.ana.email, 'ana@example.test');
  assert.deepEqual(filesWithTokens(w.dataDir), []);
  assert.equal(w.mgr.hasAccounts(), true);
  await w.mgr.remove('bob');
  assert.deepEqual(Object.keys(readRegistry(w.dataDir).accounts), ['ana']);
  assert.equal(nm(w.mgr.pickBest({ exclude: ['ana'] })), null);
  await w.mgr.remove('ana');
  assert.equal(w.mgr.hasAccounts(), false);
});

test('add() refuses bad names and leaves nothing behind', async (t) => {
  const w = await setup(t, []);
  const { writeCred, cred, vaultTargets } = await import('./holdout-accounts-helpers.js');
  writeCred(w.home, cred('zed'));
  for (const bad of ['', 'Bad', '1x', 'a_b', 'a b', '../x', 'x'.repeat(33), 'a/b', 'con\u0000']) {
    let threw = false;
    try { const r = await w.mgr.add(bad, { current: true }); threw = !!(r && (r.ok === false || r.error)); } catch { threw = true; }
    assert.ok(threw, `name ${JSON.stringify(bad)} must be refused`);
  }
  assert.equal(w.mgr.hasAccounts(), false);
  assert.deepEqual(vaultTargets(w.prefix), []);
  const r = await (async () => { try { await w.mgr.add('x'.repeat(32), { current: true }); return true; } catch { return false; } })();
  assert.ok(r, '32-char name is the longest allowed');
});

test('credentials are never written to the data dir in plain text', async (t) => {
  const w = await setup(t, ['ana', 'bob']);
  const { writeCred, cred } = await import('./holdout-accounts-helpers.js');
  writeCred(w.home, cred('ana'));
  await w.mgr.use('bob');
  await w.mgr.use('ana');
  assert.deepEqual(filesWithTokens(w.dataDir), []);
  assert.deepEqual(filesWithTokens(w.stubDir), []);
  const leftovers = fs.readdirSync(w.home).filter((f) => f !== '.credentials.json');
  assert.deepEqual(leftovers, [], 'no backup or temp copies in the home dir');
});
