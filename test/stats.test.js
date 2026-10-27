process.env.TZ = 'Pacific/Auckland'; // UTC+13 in October; weeks start on Monday local time
import test from 'node:test';
import assert from 'node:assert/strict';
import { usageStats, versionStats, runAttribution } from '../src/stats.js';
import { openStore } from '../src/store.js';
import { SEED_PRICES } from '../src/prices.js';
import { tmp } from './helpers.js';

const row = (day, model, o = {}) => ({ day, model, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, messages: 1, ...o });
const stub = (rows) => ({ daily: () => rows, status: () => ({ files: 0 }) });
const now = new Date(2026, 9, 21, 12, 0, 0); // Wednesday 21 Oct 2026, local noon

test('periods: today, Monday-start week, calendar month, and the average over days that have data', () => {
  const rows = [
    row('2026-05-01', 'claude-opus-5', { input: 1e6 }), // beyond 90 days
    row('2026-08-15', 'claude-opus-5', { input: 1e6 }), // within 90, beyond 30 days
    row('2026-09-30', 'claude-opus-5', { input: 2e6 }),
    row('2026-10-02', 'mystery-1', { input: 1000 }), // no price row
    row('2026-10-18', 'claude-opus-5', { input: 1e6 }), // Sunday: last week
    row('2026-10-19', 'claude-sonnet-5', { output: 5e5 }), // Monday: first day of this week
    row('2026-10-20', 'claude-sonnet-5', { output: 5e5 }),
    row('2026-10-21', 'claude-opus-5', { input: 1e6, cacheWrite: 1e6, cacheWrite1h: 1e6 }),
    row('2026-10-22', 'claude-opus-5', { input: 7 }), // tomorrow: not in any period
  ];
  const s = usageStats({ usage: stub(rows), prices: SEED_PRICES, now });
  assert.deepEqual([s.periods.today.input, s.periods.today.cacheWrite, s.periods.today.total], [1e6, 1e6, 2e6]);
  assert.equal(s.periods.today.cost, 5 + 10); // 1M in at $5 plus 1M of 1h cache write at $10
  assert.equal(s.periods.week.total, 2e6 + 1e6); // Mon 19, Tue 20, Wed 21 (the Sunday before is out)
  assert.equal(s.periods.week.cost, 5 + 5 + 5 + 10);
  assert.equal(s.periods.month.total, 1000 + 1e6 + 1e6 + 2e6); // from 2026-10-01; tomorrow's row is out
  assert.equal(s.periods.month.unpriced, 1000);
  assert.equal(s.unpricedModels.join(), 'mystery-1');
  assert.equal(s.daily.length, 7); // 90-day window: from 2026-07-24, today included, tomorrow's row excluded
  assert.ok(s.daily.every((d) => d.day >= '2026-07-24' && d.day <= '2026-10-21'));
  assert.deepEqual(Object.keys(s.daily[0]).sort(), ['cacheRead', 'cacheWrite', 'cost', 'day', 'input', 'model', 'output', 'total']);
  const d30 = usageStats({ usage: stub(rows), prices: SEED_PRICES, now, days: 30 });
  assert.equal(d30.daily.length, 6); // 2026-08-15 drops out
  assert.equal(s.periods.avg30.days, 8); // 05-01, 08-15, 09-30, 10-02, 10-18, 10-19, 10-20, 10-21 (tomorrow excluded)
});

test('avg30 averages over the latest 30 days that have data, not calendar days', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) rows.push(row(`2026-0${i < 31 ? 8 : 9}-${String(i < 31 ? i + 1 : i - 30).padStart(2, '0')}`, 'claude-opus-5', { input: 100 }));
  rows.push(row('2026-10-21', 'claude-opus-5', { input: 300 })); // a gap of weeks before it does not dilute the average
  const s = usageStats({ usage: stub(rows), prices: SEED_PRICES, now });
  assert.equal(s.periods.avg30.days, 30);
  assert.equal(s.periods.avg30.input, Math.round((29 * 100 + 300) / 30));
  assert.equal(s.periods.avg30.total, s.periods.avg30.input);
});

test('empty usage gives zeros', () => {
  const s = usageStats({ usage: stub([]), prices: SEED_PRICES, now });
  assert.deepEqual([s.periods.today.total, s.periods.avg30.days, s.periods.avg30.cost, s.daily.length], [0, 0, 0, 0]);
});

// Stand-in for the indexer: messages() returns rows, totals() sums them per (agent, session, model); both count their calls.
function fakeUsage(msgs, status = {}) {
  const u = {
    calls: { messages: 0, totals: 0 }, state: { generation: 0, lastScanAt: null, ...status }, prices: () => SEED_PRICES, status: () => u.state,
    messages: ({ agentIds }) => { u.calls.messages++; return msgs.filter((x) => agentIds?.includes(x.agentId)); },
    totals: ({ agentIds, sessionIds, agentNull }) => {
      u.calls.totals++;
      const sums = new Map();
      for (const m of msgs.filter((x) => (agentIds && agentIds.includes(x.agentId)) || (sessionIds && sessionIds.includes(x.sessionId) && (!agentNull || x.agentId == null)))) {
        const k = `${m.agentId}|${m.sessionId}|${m.model}`;
        const a = sums.get(k) ?? { agentId: m.agentId, sessionId: m.sessionId, model: m.model, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
        for (const f of ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead']) a[f] += m[f];
        sums.set(k, a);
      }
      return [...sums.values()];
    },
  };
  return u;
}

// Walks a run to its end node.
function finish(store, id) {
  for (let i = 0; i < 60; i++) {
    const r = store.getRun(id);
    if (r.status === 'done') return;
    const sum = store.summary(r);
    const res = r.status === 'waiting' ? store.respond(id, { action: sum.actions[0].label }) : store.completeStage(id, { stage: sum.active[0].id, outcome: 'pass' });
    if (res.error) throw new Error(res.error);
  }
  throw new Error('run did not finish');
}

test('version stats: finished runs only, newest version first, per-node means', () => {
  const store = openStore(tmp());
  const msgs = [];
  const mk = (title, session) => {
    const id = store.startRun({ title }).run.id;
    finish(store, id);
    store.createAgent({ id: `main:${session}`, runId: id, sessionId: session, type: 'main' });
    return id;
  };
  const a = mk('Run a', 'SA');
  const b = mk('Run b', 'SB');
  store.startRun({ title: 'Unfinished' }); // still running: ignored
  const stopped = store.startRun({ title: 'Stopped run' }).run.id;
  store.stopRun(stopped);
  store.createAgent({ id: 'subA', runId: a, sessionId: 'SA', type: 'general-purpose' });
  store.reportNode('subA', 'frame');
  const m = (id, agentId, sessionId, ts, input) => ({ id, ts, day: ts.slice(0, 10), sessionId, agentId, model: 'claude-opus-5', input, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });
  msgs.push(m('1', 'subA', 'SA', store.getRun(a).created_at, 1000), m('2', null, 'SA', store.getRun(a).created_at, 500), m('3', null, 'SB', store.getRun(b).created_at, 100));
  const usage = fakeUsage(msgs);
  // second version, no runs yet
  const draft = store.draft().workflow;
  draft.nodes.find((n) => n.id === 'frame').name = 'Frame it';
  store.saveDraft(draft);
  assert.deepEqual(store.publish(), { version: 2 });

  const v = versionStats(store, usage);
  assert.deepEqual(v.map((x) => [x.version, x.finishedRuns]), [[2, 0], [1, 2]]);
  assert.equal(v[0].avgTokens, 0);
  const v1 = v[1];
  assert.equal(v1.avgTokens, (1500 + 100) / 2);
  const dur = (id) => Date.parse(store.getRun(id).ended_at) - Date.parse(store.getRun(id).created_at);
  assert.equal(v1.avgDurationMs, (dur(a) + dur(b)) / 2);
  const frame = v1.nodes.find((n) => n.id === 'frame');
  assert.deepEqual([frame.name, frame.runs, frame.avgTokens], ['Frame', 2, 500]); // 1000 for run a, 0 for run b
  assert.equal(v1.nodes.length, 18);
  const stage = (id) => store.attributionInput(id).visits.filter((x) => x.node === 'verify').reduce((t, x) => t + Date.parse(x.leftAt) - Date.parse(x.enteredAt), 0);
  assert.equal(v1.nodes.find((n) => n.id === 'verify').avgDurationMs, (stage(a) + stage(b)) / 2);
  assert.equal(v[0].nodes.find((n) => n.id === 'frame').name, 'Frame it');
  store.close();
});

test('runAttribution is memoised: repeat calls do not recompute, a new indexer generation does; a long-ended run is frozen', () => {
  const store = openStore(tmp());
  const id = store.startRun({ title: 'Memo' }).run.id;
  store.createAgent({ id: 'main:SM', runId: id, sessionId: 'SM', type: 'main' });
  store.createAgent({ id: 'w', runId: id, sessionId: 'SM', type: 'worker' });
  store.reportNode('w', 'frame');
  const created = store.getRun(id).created_at;
  const m = (mid, agentId, input) => ({ id: mid, ts: created, day: created.slice(0, 10), sessionId: 'SM', agentId, model: 'claude-opus-5', input, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 });
  const msgs = [m('1', 'w', 10), m('2', null, 3)];
  const usage = fakeUsage(msgs);
  const first = runAttribution(store, usage, id);
  assert.deepEqual([first.total.total, first.main.total, first.nodes.frame.total], [13, 3, 10]);
  assert.deepEqual(usage.calls, { messages: 0, totals: 2 }, 'only aggregate queries for a non-lead agent and the main session');
  for (let i = 0; i < 5; i++) runAttribution(store, usage, id);
  assert.equal(usage.calls.totals, 2, 'same generation: served from the memo');

  msgs.push(m('3', 'w', 100));
  assert.equal(runAttribution(store, usage, id).total.total, 13, 'nothing new is indexed yet');
  usage.state.generation++;
  assert.equal(runAttribution(store, usage, id).total.total, 113, 'a new indexer generation recomputes');
  assert.equal(usage.calls.totals, 4);

  // price edits change the numbers even with the same generation
  const cost = runAttribution(store, usage, id).total.cost;
  usage.prices = () => SEED_PRICES.map((p) => ({ ...p, input: p.input * 2 }));
  assert.equal(runAttribution(store, usage, id).total.cost, cost * 2);

  // an ended run is frozen once a scan finished more than 60 s after it ended
  store.stopRun(id);
  const ended = Date.parse(store.getRun(id).ended_at);
  usage.state.lastScanAt = new Date(ended + 30_000).toISOString();
  runAttribution(store, usage, id);
  const before = usage.calls.totals;
  usage.state.generation++;
  runAttribution(store, usage, id);
  assert.equal(usage.calls.totals, before + 2, 'scan only 30 s after the end: not frozen yet');
  usage.state.lastScanAt = new Date(ended + 61_000).toISOString();
  usage.state.generation++;
  runAttribution(store, usage, id);
  const frozen = usage.calls.totals;
  for (let i = 0; i < 3; i++) { usage.state.generation++; runAttribution(store, usage, id); }
  assert.equal(usage.calls.totals, frozen, 'frozen: later generations do not recompute');
  store.close();
});

test('runAttribution loads per-message rows only for lead agents', () => {
  const store = openStore(tmp());
  const id = store.startRun({ title: 'Leads' }).run.id;
  store.createAgent({ id: 'main:SL', runId: id, sessionId: 'SL', type: 'main' });
  store.createAgent({ id: 'L', runId: id, sessionId: 'SL', type: 'fable-lead' });
  store.createAgent({ id: 'w', runId: id, sessionId: 'SL', type: 'worker' });
  const usage = fakeUsage([]);
  const seen = [];
  usage.messages = (q) => { seen.push(q.agentIds); return []; };
  runAttribution(store, usage, id);
  assert.deepEqual(seen, [['L']]);
  store.close();
});
