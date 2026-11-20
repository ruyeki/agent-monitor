// Baseline (Stats page #2246): what the stats server code does today (periods, unpriced, codex split); must pass before and after the change.
process.env.TZ = 'Pacific/Auckland';
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageStats, versionStats } from '../src/stats.js';
import { openStore } from '../src/store.js';
import { SEED_PRICES } from '../src/prices.js';
import { boot } from './e2e/helpers.js';
import { tmp } from './helpers.js';

const row = (day, model, o = {}) => ({ day, model, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1, ...o });
const stub = (rows) => ({ daily: () => rows, status: () => ({ files: 0 }) });
const now = new Date(2026, 9, 21, 12, 0, 0);

test('periods, daily values, unpriced models and the codex split are unchanged', () => {
  const rows = [
    row('2026-10-21', 'claude-opus-5', { input: 1e6, output: 1e5, cacheWrite: 1e6, cacheWrite1h: 1e6, cacheRead: 2e6 }),
    row('2026-10-21', 'mystery-1', { input: 1000 }),
    row('2026-10-21', 'gpt-x', { input: 5000, output: 100 }),
    row('2026-10-20', 'claude-sonnet-5', { output: 5e5 }),
  ];
  rows[2].provider = 'codex';
  const s = usageStats({ usage: stub(rows), prices: SEED_PRICES, now });
  assert.equal(s.periods.today.total, 1e6 + 1e5 + 1e6 + 2e6 + 1000);
  assert.equal(s.periods.today.cost, 5 + 2.5 + 10 + 1);
  assert.equal(s.periods.today.unpriced, 1000);
  assert.equal(s.periods.week.total, s.periods.today.total + 5e5);
  assert.equal(s.codex.today.total, 5100);
  assert.deepEqual(s.unpricedModels, ['mystery-1']);
  const opus = s.daily.find((d) => d.model === 'claude-opus-5');
  assert.deepEqual([opus.day, opus.input, opus.output, opus.cacheWrite, opus.cacheRead, opus.total, opus.cost], ['2026-10-21', 1e6, 1e5, 1e6, 2e6, 4.1e6, 5 + 2.5 + 10 + 1]);
  assert.equal(s.daily.length, 4);
  assert.equal(s.daily.filter((d) => d.provider === 'codex').length, 1);
  for (const k of ['indexer', 'codex', 'periods', 'daily', 'unpricedModels']) assert.ok(k in s, k);
});

test('days: default 90, 30 limits the window, today is included and tomorrow is not', () => {
  const rows = [row('2026-07-23', 'claude-opus-5', { input: 1 }), row('2026-07-24', 'claude-opus-5', { input: 1 }), row('2026-09-21', 'claude-opus-5', { input: 1 }), row('2026-09-22', 'claude-opus-5', { input: 1 }), row('2026-10-21', 'claude-opus-5', { input: 1 }), row('2026-10-22', 'claude-opus-5', { input: 1 })];
  assert.deepEqual(usageStats({ usage: stub(rows), prices: SEED_PRICES, now }).daily.map((d) => d.day), ['2026-07-24', '2026-09-21', '2026-09-22', '2026-10-21']);
  assert.deepEqual(usageStats({ usage: stub(rows), prices: SEED_PRICES, now, days: 30 }).daily.map((d) => d.day), ['2026-09-22', '2026-10-21']);
});

test('HTTP: /api/stats/usage serves 30 and 90 day windows and falls back to 90 on junk; versions endpoint keeps its fields', async () => {
  const s = await boot({});
  try {
    const d90 = (await s.api('GET', '/api/stats/usage')).json;
    assert.equal((await s.api('GET', '/api/stats/usage?days=30')).status, 200);
    for (const q of ['days=abc', 'days=', 'days=-5', 'days=0', 'days=1e2', 'days=99999']) {
      const r = await s.api('GET', `/api/stats/usage?${q}`);
      assert.equal(r.status, 200, q);
      assert.deepEqual(r.json.daily, d90.daily, q);
    }
    const v = (await s.api('GET', '/api/stats/versions')).json;
    assert.equal(v.length, 1);
    for (const k of ['version', 'publishedAt', 'finishedRuns', 'avgTokens', 'avgDurationMs', 'nodes']) assert.ok(k in v[0], k);
    for (const k of ['id', 'name', 'runs', 'avgTokens', 'avgDurationMs']) assert.ok(k in v[0].nodes[0], k);
    const wv = (await s.api('GET', '/api/workflow/versions')).json;
    assert.deepEqual(Object.keys(wv[0].stats).sort(), ['avgDurationMs', 'avgTokens', 'finishedRuns']);
  } finally { await s.srv.close(); }
});

test('versionStats: finished runs only, newest first, per-node token means (unchanged)', () => {
  const store = openStore(tmp());
  const id = store.startRun({ title: 'Run a' }).run.id;
  for (let i = 0; i < 60 && store.getRun(id).status !== 'done'; i++) {
    const r = store.getRun(id); const sum = store.summary(r);
    if (r.status === 'waiting') store.respond(id, { action: sum.actions[0].label }); else store.completeStage(id, { stage: sum.active[0].id, outcome: 'pass' });
  }
  store.startRun({ title: 'Open' });
  const usage = { status: () => ({ generation: 1, lastScanAt: null }), prices: () => SEED_PRICES, messages: () => [], totals: () => [] };
  const v = versionStats(store, usage);
  assert.deepEqual([v.length, v[0].version, v[0].finishedRuns, v[0].avgTokens, v[0].nodes.length], [1, 1, 1, 0, 18]);
  store.close();
});
