import test from 'node:test';
import assert from 'node:assert/strict';
import { windowPct, usageLeft, limitedUntil, isAvailable, pickBest, attribute, fromRateLimitInfo, toSecs, LIMIT_FALLBACK_MS } from '../src/accounts/usage.js';
import { NOW, win, secs } from './accounts-helpers.js';

const later = secs(NOW + 3600_000);
const passed = secs(NOW - 1000);

test('usage: a window counts 0 when absent or reset, else its clamped %', () => {
  assert.equal(windowPct(null, NOW), 0);
  assert.equal(windowPct(win(80, passed), NOW), 0);
  assert.equal(windowPct(win(80, secs(NOW)), NOW), 0, 'resets_at == now has reset');
  assert.equal(windowPct(win(80, later), NOW), 80);
  assert.equal(windowPct(win(140, later), NOW), 100);
  assert.equal(windowPct(win(-3, later), NOW), 0);
});

test('usage: left is 100 minus the higher window; no reading = 100', () => {
  assert.equal(usageLeft(null, NOW), 100);
  assert.equal(usageLeft({ five_hour: win(15, later), seven_day: win(37, later) }, NOW), 63);
  assert.equal(usageLeft({ five_hour: win(90, later), seven_day: win(37, later) }, NOW), 10);
  assert.equal(usageLeft({ five_hour: win(90, passed), seven_day: win(37, later) }, NOW), 63, 'a reset 5h window is fresh');
  assert.equal(usageLeft({ five_hour: null, seven_day: win(100, later) }, NOW), 0);
  assert.equal(usageLeft({ five_hour: null, seven_day: null }, NOW), 100);
});

test('usage: limitedUntil is resetsAt when later than the hit, else hit + 5 h', () => {
  const at = new Date(NOW).toISOString();
  assert.equal(limitedUntil(null), null);
  assert.equal(limitedUntil({ at, resetsAt: later }), later * 1000);
  assert.equal(limitedUntil({ at, resetsAt: null }), NOW + LIMIT_FALLBACK_MS);
  assert.equal(limitedUntil({ at, resetsAt: secs(NOW) }), NOW + LIMIT_FALLBACK_MS, 'resetsAt == at');
  assert.equal(limitedUntil({ at, resetsAt: passed }), NOW + LIMIT_FALLBACK_MS, 'resetsAt before at');
});

test('usage: available needs a saved login, no live limit and usage left', () => {
  const at = new Date(NOW - 60_000).toISOString();
  assert.equal(isAvailable({ name: 'a', saved: true, usage: { reading: null, limit: null } }, NOW), true);
  assert.equal(isAvailable({ name: 'a', saved: false, usage: { reading: null, limit: null } }, NOW), false);
  assert.equal(isAvailable({ name: 'a', saved: true, usage: { reading: null, limit: { at, resetsAt: later } } }, NOW), false);
  assert.equal(isAvailable({ name: 'a', saved: true, usage: { reading: null, limit: { at, resetsAt: later } } }, later * 1000), true, 'after the reset');
  assert.equal(isAvailable({ name: 'a', saved: true, usage: { reading: { five_hour: win(100, later) }, limit: null } }, NOW), false);
});

test('pickBest: most left wins; hit, limited and unsaved accounts are skipped; ties go by name', () => {
  const at = new Date(NOW - 60_000).toISOString();
  const acct = (name, reading, extra = {}) => ({ name, saved: true, usage: { reading, limit: null }, ...extra });
  const accounts = [
    acct('ryan', { five_hour: win(10, later) }),
    acct('orders', { five_hour: win(40, later) }),
    acct('lab', null, { saved: false }),
    acct('zed', null, { usage: { reading: null, limit: { at, resetsAt: later } } }),
  ];
  assert.equal(pickBest(accounts, NOW), 'ryan');
  assert.equal(pickBest(accounts, NOW, ['ryan']), 'orders');
  assert.equal(pickBest(accounts, NOW, ['ryan', 'orders']), null, 'lab has no saved login, zed is limited');
  assert.equal(pickBest([acct('b', null), acct('a', null)], NOW), 'a');
  assert.equal(pickBest([acct('b', { five_hour: win(20, later) }), acct('a', { seven_day: win(20, later) })], NOW), 'a');
  assert.equal(pickBest([], NOW), null);
});

test('attribute: a reset time stored on another account wins, else the active account', () => {
  const usages = {
    ryan: { reading: { five_hour: win(10, 1000), seven_day: win(5, 2000) }, limit: null },
    orders: { reading: { five_hour: win(10, 3000), seven_day: win(5, 4000) }, limit: { at: 'x', resetsAt: 5000 } },
  };
  const names = ['ryan', 'orders'];
  assert.equal(attribute(names, 'ryan', usages, 3000), 'orders');
  assert.equal(attribute(names, 'ryan', usages, 4000), 'orders');
  assert.equal(attribute(names, 'ryan', usages, 5000), 'orders', 'a stored limit resetsAt');
  assert.equal(attribute(names, 'ryan', usages, 1000), 'ryan');
  assert.equal(attribute(names, 'ryan', usages, 9999), 'ryan');
  assert.equal(attribute(names, 'ryan', usages, null), 'ryan');
  assert.equal(attribute(names, null, usages, 3000), 'orders');
  assert.equal(attribute(names, null, usages, 9999), null);
});

test('fromRateLimitInfo: unified windows become percent windows; toSecs reads s, ms and ISO', () => {
  const info = { status: 'allowed', resetsAt: 1795059600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1795059600 }, seven_day: { utilization: 0.37, resetsAt: 1795284000 } } };
  assert.deepEqual(fromRateLimitInfo(info), { five_hour: { used_percentage: 15, resets_at: 1795059600 }, seven_day: { used_percentage: 37, resets_at: 1795284000 } });
  assert.deepEqual(fromRateLimitInfo({ rateLimitType: 'seven_day', utilization: 0.5, resetsAt: 7 }), { five_hour: null, seven_day: { used_percentage: 50, resets_at: 7 } });
  assert.deepEqual(fromRateLimitInfo(null), { five_hour: null, seven_day: null });
  assert.equal(toSecs(1795059600), 1795059600);
  assert.equal(toSecs(1795059600000), 1795059600);
  assert.equal(toSecs(new Date(1795059600000).toISOString()), 1795059600);
  assert.equal(toSecs(null), null);
  assert.equal(toSecs('junk'), null);
});
