// Holdout (Stats page #2246): additive server fields for the cost-first Stats page (per-token-type costs on daily rows).
process.env.TZ = 'Pacific/Auckland';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { usageStats, versionStats } from '../src/stats.js';
import { openStore } from '../src/store.js';
import { SEED_PRICES } from '../src/prices.js';
import { boot, until } from './e2e/helpers.js';
import { tmp } from './helpers.js';

const row = (day, model, o = {}) => ({ day, model, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1, ...o });
const stub = (rows) => ({ daily: () => rows, status: () => ({ files: 0 }) });
const now = new Date(2026, 9, 21, 12, 0, 0);
const near = (a, b, m = '') => assert.ok(Math.abs(a - b) < 1e-9, `${m} ${a} vs ${b}`);

test('daily rows carry costs per token type that sum to the row cost; both cache tiers go to cacheWrite', () => {
  const rows = [
    row('2026-10-21', 'claude-opus-5', { input: 1e6, output: 2e5, cacheWrite: 1e6, cacheWrite1h: 4e5, cacheRead: 3e6 }),
    row('2026-10-21', 'mystery-1', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 }),
    row('2026-10-20', 'claude-haiku-4-5-20251001', { input: 123456, output: 7, cacheWrite: 99, cacheRead: 5 }),
  ];
  const s = usageStats({ usage: stub(rows), prices: SEED_PRICES, now });
  for (const d of s.daily) {
    assert.deepEqual(Object.keys(d.costs).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
    near(d.costs.input + d.costs.output + d.costs.cacheWrite + d.costs.cacheRead, d.cost, d.model);
    for (const v of Object.values(d.costs)) assert.ok(v >= 0 && Number.isFinite(v));
  }
  const opus = s.daily.find((d) => d.model === 'claude-opus-5');
  near(opus.costs.input, 5, 'input'); near(opus.costs.output, 5, 'output'); near(opus.costs.cacheRead, 1.5, 'read');
  near(opus.costs.cacheWrite, 0.6 * 6.25 + 0.4 * 10, 'write (5m + 1h tiers)');
  assert.deepEqual(s.daily.find((d) => d.model === 'mystery-1').costs, { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  assert.equal(opus.total, 1e6 + 2e5 + 1e6 + 3e6); // existing fields untouched
  near(opus.cost, 5 + 5 + 7.75 + 1.5);
});

test('firstDay is the earliest non-codex day over all time (not limited by days), null when none', () => {
  const codex = row('2026-01-01', 'gpt-x', { input: 5 }); codex.provider = 'codex';
  const rows = [codex, row('2026-03-05', 'claude-opus-5', { input: 1 }), row('2026-10-21', 'claude-opus-5', { input: 1 })];
  for (const days of [7, 30, 90, undefined]) assert.equal(usageStats({ usage: stub(rows), prices: SEED_PRICES, now, days }).firstDay, '2026-03-05', String(days));
  assert.equal(usageStats({ usage: stub([codex]), prices: SEED_PRICES, now }).firstDay, null);
  assert.equal(usageStats({ usage: stub([]), prices: SEED_PRICES, now }).firstDay, null);
});

test('versionStats: avgCost on versions and nodes, mean over the same runs as avgTokens, 0 when none', () => {
  const store = openStore(tmp());
  const mk = (title, session) => {
    const id = store.startRun({ title }).run.id;
    for (let i = 0; i < 60 && store.getRun(id).status !== 'done'; i++) {
      const r = store.getRun(id); const sum = store.summary(r);
      if (r.status === 'waiting') store.respond(id, { action: sum.actions[0].label }); else store.completeStage(id, { stage: sum.active[0].id, outcome: 'pass' });
    }
    store.createAgent({ id: `main:${session}`, runId: id, sessionId: session, type: 'main' });
    return id;
  };
  const a = mk('Run a', 'SA'); const b = mk('Run b', 'SB');
  store.createAgent({ id: 'subA', runId: a, sessionId: 'SA', type: 'general-purpose' });
  store.reportNode('subA', 'frame');
  const m = (id, agentId, sessionId, ts, input) => ({ id, ts, day: ts.slice(0, 10), sessionId, agentId, model: 'claude-opus-5', input, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });
  const msgs = [m('1', 'subA', 'SA', store.getRun(a).created_at, 1000), m('2', null, 'SA', store.getRun(a).created_at, 500), m('3', null, 'SB', store.getRun(b).created_at, 100)];
  const usage = {
    status: () => ({ generation: 1, lastScanAt: null }), prices: () => SEED_PRICES,
    messages: ({ agentIds }) => msgs.filter((x) => agentIds?.includes(x.agentId)),
    totals: ({ agentIds, sessionIds, agentNull }) => {
      const sums = new Map();
      for (const x of msgs.filter((y) => (agentIds && agentIds.includes(y.agentId)) || (sessionIds && sessionIds.includes(y.sessionId) && (!agentNull || y.agentId == null)))) {
        const k = `${x.agentId}|${x.sessionId}|${x.model}`;
        const acc = sums.get(k) ?? { agentId: x.agentId, sessionId: x.sessionId, model: x.model, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
        acc.input += x.input; sums.set(k, acc);
      }
      return [...sums.values()];
    },
  };
  const draft = store.draft().workflow; draft.nodes.find((n) => n.id === 'frame').name = 'Frame it'; store.saveDraft(draft); store.publish();
  const [v2, v1] = versionStats(store, usage);
  assert.equal(v2.avgCost, 0);
  assert.ok(v2.nodes.every((n) => n.avgCost === 0));
  near(v1.avgCost, (1500 * 5e-6 + 100 * 5e-6) / 2, 'version avgCost');
  const frame = v1.nodes.find((n) => n.id === 'frame');
  assert.equal(typeof frame.avgCost, 'number');
  near(frame.avgCost, (1000 * 5e-6 + 0) / 2, 'frame avgCost');
  for (const n of v1.nodes) assert.ok(Number.isFinite(n.avgCost) && n.avgCost >= 0, n.id);
  assert.equal(v1.avgTokens, 800); assert.equal(frame.avgTokens, 500); // existing fields unchanged
  store.close();
});

test('HTTP: days accepts any integer 1..366; everything else is 90; never a 500; new fields are on the wire', async () => {
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'am-proj-'));
  const ts = (k) => { const d = new Date(); d.setDate(d.getDate() - k); d.setHours(12, 0, 0, 0); return d.toISOString(); };
  const line = (id, k) => JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: ts(k), message: { id, model: 'claude-opus-5-5-20261001', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 1000, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } } });
  fs.mkdirSync(path.join(projects, 'p'), { recursive: true });
  const days = [0, 3, 6, 7, 13, 20, 29, 30, 59, 60, 100, 170, 200, 400];
  fs.writeFileSync(path.join(projects, 'p', 's1.jsonl'), days.map((k, i) => line(`m${i}`, k)).join('\n') + '\n');
  const s = await boot({ projects });
  try {
    assert.ok(await until(async () => (await s.api('GET', '/api/stats/usage')).json.indexer?.messages >= days.length, 15000, 150), 'not indexed');
    const span = (j) => new Set(j.daily.map((d) => d.day)).size;
    const get = async (q) => { const r = await s.api('GET', `/api/stats/usage${q}`); assert.equal(r.status, 200, q); return r.json; };
    const base90 = span(await get(''));
    assert.equal(base90, days.filter((k) => k <= 89).length);
    for (const n of [1, 7, 14, 60, 180, 366]) assert.equal(span(await get(`?days=${n}`)), days.filter((k) => k <= n - 1).length, `days=${n}`);
    for (const q of ['days=0', 'days=367', 'days=-3', 'days=abc', 'days=', 'days=7.5', 'days=1e2', 'days=%207', 'days=7;8', 'days=99999999999999999999']) {
      assert.equal(span(await get(`?${q}`)), base90, `${q} falls back to 90`);
    }
    assert.equal((await s.api('GET', '/api/stats/usage?days=7&days=30')).status, 200);
    const j = await get('?days=30');
    assert.equal(j.firstDay, new Date(ts(400)).toLocaleDateString('en-CA'));
    for (const d of j.daily) assert.ok(d.costs && typeof d.costs.input === 'number');
    const v = (await s.api('GET', '/api/stats/versions')).json;
    assert.equal(typeof v[0].avgCost, 'number');
    assert.equal(typeof v[0].nodes[0].avgCost, 'number');
    const wv = (await s.api('GET', '/api/workflow/versions')).json;
    assert.deepEqual(Object.keys(wv[0].stats).sort(), ['avgDurationMs', 'avgTokens', 'finishedRuns']); // unchanged
  } finally { await s.srv.close(); }
});
