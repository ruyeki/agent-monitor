import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SEED_PRICES, priceFor, costOf, validatePrices } from '../src/prices.js';

test('priceFor picks the longest id prefix', () => {
  assert.equal(priceFor(SEED_PRICES, 'claude-haiku-4-5-20251001').model, 'claude-haiku-4-5');
  assert.equal(priceFor(SEED_PRICES, 'claude-opus-5-5').model, 'claude-opus-5-5');
  assert.equal(priceFor(SEED_PRICES, 'claude-opus-5-20260101').model, 'claude-opus-5');
  assert.equal(priceFor(SEED_PRICES, 'claude-fable-5-1-x').model, 'claude-fable-5-1');
  assert.equal(priceFor(SEED_PRICES, 'claude-fable-5').model, 'claude-fable-5');
  // claude-opus-5 must not catch a longer, different id such as claude-opus-50
  assert.equal(priceFor([{ model: 'claude-opus-5-5' }, { model: 'claude-opus-5' }], 'claude-opus-5').model, 'claude-opus-5');
  assert.equal(priceFor([{ model: 'claude-opus-5-5' }], 'claude-opus-5'), null);
});

test('unknown or missing model gives no price and a null cost', () => {
  assert.equal(priceFor(SEED_PRICES, 'gpt-9'), null);
  assert.equal(priceFor(SEED_PRICES, null), null);
  assert.equal(priceFor(SEED_PRICES, '<synthetic>'), null);
  assert.equal(costOf({ input: 1 }, null), null);
});

test('costOf splits 5m and 1h cache writes', () => {
  const price = priceFor(SEED_PRICES, 'claude-opus-5-20260101'); // 5 / 25 / 6.25 / 10 / 0.5
  const row = { input: 1_000_000, output: 1_000_000, cacheWrite: 2_000_000, cacheWrite1h: 500_000, cacheRead: 4_000_000 };
  // 5 + 25 + 1.5M*6.25 + 0.5M*10 + 4M*0.5
  assert.ok(Math.abs(costOf(row, price) - (5 + 25 + 9.375 + 5 + 2)) < 1e-9);
  assert.equal(costOf({}, price), 0);
});

test('validatePrices checks numbers, prefix and row count', () => {
  const ok = { model: 'a', input: 0, output: 1, cacheWrite: 2, cacheWrite1h: 3, cacheRead: 4 };
  assert.deepEqual(validatePrices([ok]).rows, [{ ...ok, note: '' }]);
  for (const bad of [-1, NaN, Infinity, '1', null]) assert.ok(validatePrices([{ ...ok, input: bad }]).error, String(bad));
  assert.ok(validatePrices([{ ...ok, model: 'x'.repeat(81) }]).error);
  assert.ok(validatePrices([{ ...ok, model: 'x'.repeat(80) }]).rows);
  assert.ok(validatePrices([{ ...ok, model: 7 }]).error);
  assert.ok(validatePrices({}).error);
  assert.ok(validatePrices(Array.from({ length: 101 }, (_, i) => ({ ...ok, model: `m${i}` }))).error);
});
