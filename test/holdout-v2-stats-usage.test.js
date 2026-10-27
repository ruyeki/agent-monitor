// Holdout (phase B, AC11/AC12): GET /api/stats/usage (periods with TZ, avg30, daily, cost, unpriced), GET/PUT /api/prices.
// The whole file runs under TZ=Pacific/Auckland (UTC+13 now), so a UTC-based day would be wrong for messages near local midnight.
process.env.TZ = 'Pacific/Auckland';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, load, until, req, tline, writeLines, mainFile, localDay, tokTotal } from './holdout-v2-helpers.js';

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'am-proj-'));
let S; let P; const rows = []; let n = 0;
const DAY = 86400000;
const localAt = (daysAgo, h, m = 0) => { const d = new Date(); d.setDate(d.getDate() - daysAgo); d.setHours(h, m, 0, 0); return d; };
const add = (ts, o = {}) => { const id = `u${++n}`; rows.push({ id, ts: new Date(ts), model: 'claude-sonnet-5-5-20261001', input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, ...o }); };
const usage = (days) => S.api('GET', '/api/stats/usage' + (days ? `?days=${days}` : ''));
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} vs ${b}`);
const costOf = (r) => { const p = P.priceFor(P.SEED_PRICES, r.model); return p ? P.costOf(r, p) : 0; };
const agg = (rs) => {
  const t = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, cost: 0 };
  for (const r of rs) { t.input += r.input; t.output += r.output; t.cacheWrite += r.cacheWrite; t.cacheRead += r.cacheRead; t.cost += costOf(r); }
  return { ...t, total: t.input + t.output + t.cacheWrite + t.cacheRead };
};
const sameTokens = (got, want, label, tol = 0) => {
  for (const k of ['input', 'output', 'cacheWrite', 'cacheRead', 'total']) assert.ok(Math.abs(got[k] - want[k]) <= tol, `${label} ${k}: ${got[k]} vs ${want[k]}`);
  near(got.cost, want.cost, 1e-6);
};

before(async () => {
  P = await load('src/prices.js');
  const now = Date.now();
  // today: one big priced message (longest-prefix opus-5-5, with a 1h cache write), one unpriced model
  add(now - 1000, { model: 'claude-opus-5-5-20261001', input: 1e6, output: 1e5, cacheWrite: 4e5, cacheWrite1h: 1e5, cacheRead: 1e6 });
  add(now - 2000, { model: 'claude-mystery-1', input: 5000, output: 500 });
  // yesterday, either side of local midnight: UTC days would differ from the local day
  add(localAt(1, 0, 30), { model: 'claude-opus-5-5-20261001', input: 10, output: 5 });
  add(localAt(1, 23, 30), { model: 'claude-opus-5-5-20261001', input: 20, output: 5 });
  // one sonnet message at local noon on days with data
  const noon = [...Array(10).keys(), 29, 30, ...Array.from({ length: 30 }, (_, i) => 40 + i), 100].filter((k) => k !== 0);
  for (const k of noon) add(localAt(k, 12), { input: 1000 + k, output: 10, cacheWrite: 100, cacheWrite1h: 40, cacheRead: 500 });
  writeLines(mainFile(PROJ, 'sess-u'), rows.map((r) => tline({ id: r.id, ts: r.ts, session: 'sess-u', model: r.model, input: r.input, output: r.output, cacheWrite: r.cacheWrite, cacheWrite1h: r.cacheWrite1h, cacheRead: r.cacheRead })));
  S = await boot({ projects: PROJ });
  await until(async () => (await usage()).json?.indexer?.messages >= rows.length, 12000, 100);
});
after(async () => { await S?.srv.close(); });

test('AC11 /api/stats/usage has indexer status, periods, daily and unpricedModels', async () => {
  const r = await usage();
  assert.equal(r.status, 200);
  for (const k of ['indexer', 'periods', 'daily', 'unpricedModels']) assert.ok(k in r.json, k);
  assert.deepEqual(Object.keys(r.json.periods).sort(), ['avg30', 'month', 'today', 'week']);
  assert.equal(r.json.indexer.messages, rows.length);
  assert.ok(r.json.indexer.files >= 1);
  for (const f of ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost']) assert.equal(typeof r.json.periods.today[f], 'number', f);
});

test('AC11 periods: today, this week (from Monday 00:00 local) and this month (from the 1st, local) sum the right days, with TZ honoured', async () => {
  const { periods } = (await usage()).json;
  const now = new Date();
  const today = localDay(now);
  const monday = new Date(now); monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
  const firstOfMonth = `${today.slice(0, 8)}01`;
  const within = (from) => rows.filter((r) => localDay(r.ts) >= from);
  sameTokens(periods.today, agg(within(today)), 'today');
  sameTokens(periods.week, agg(within(localDay(monday))), 'week');
  sameTokens(periods.month, agg(within(firstOfMonth)), 'month');
  assert.ok(periods.today.total >= 2.5e6, 'today holds the big message');
});

test('AC11 avg30 averages the 30 most recent local days that HAVE data (not the last 30 calendar days), and reports days', async () => {
  const { periods } = (await usage()).json;
  const byDay = new Map();
  for (const r of rows) (byDay.get(localDay(r.ts)) ?? byDay.set(localDay(r.ts), []).get(localDay(r.ts))).push(r);
  const recent = [...byDay.keys()].sort().reverse().slice(0, 30);
  assert.equal(recent.length, 30);
  const sum = agg(recent.flatMap((d) => byDay.get(d)));
  const want = Object.fromEntries(Object.entries(sum).map(([k, v]) => [k, v / 30]));
  assert.equal(periods.avg30.days, 30);
  sameTokens(periods.avg30, want, 'avg30', 1);
  const calendar30 = rows.filter((r) => Date.now() - r.ts.getTime() < 30 * DAY);
  assert.notEqual(Math.round(agg(calendar30).total / 30), Math.round(periods.avg30.total), 'fixture distinguishes the two readings');
});

test('AC11 daily: only days with data inside the window (30 or 90, default 90), one row per day and model', async () => {
  const d90 = (await usage()).json.daily;
  const d30 = (await usage(30)).json.daily;
  const days = (d) => new Set(d.map((r) => r.day));
  const keys = (d) => d.map((r) => `${r.day}|${r.model}`);
  assert.equal(new Set(keys(d90)).size, d90.length, 'one row per (day, model)');
  const startOf = (k) => localDay(localAt(k, 12)); // the local day k days ago
  assert.equal(days(d90).has(startOf(100)), false, '100 days ago is outside 90');
  assert.equal(days(d90).has(startOf(69)), true);
  assert.equal(days(d30).has(startOf(29)), true, 'the 30th day (today + 29 back) is included');
  assert.equal(days(d30).has(startOf(30)), false);
  assert.equal(days(d30).has(startOf(45)), false);
  assert.equal(days(d90).has(startOf(15)), false, 'no data that day, so no row');
  for (const r of d90) for (const f of ['day', 'model', 'input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost']) assert.ok(f in r, f);
  const bogus = await usage(7);
  assert.ok(bogus.status < 500, 'an unsupported days value never crashes');
});

test('AC11 daily rows: local day boundary (TZ), total, 1h cache write cost and longest-prefix pricing', async () => {
  const { daily } = (await usage()).json;
  const yest = localDay(localAt(1, 12));
  const opusYest = daily.find((r) => r.day === yest && r.model.startsWith('claude-opus-5-5'));
  assert.equal(opusYest?.input, 30, 'both messages either side of local midnight are in the same local day');
  assert.equal(opusYest.total, 30 + 10);
  const big = daily.find((r) => r.day === localDay(Date.now() - 1000) && r.model.startsWith('claude-opus-5-5') && r.input >= 1e6);
  assert.ok(big, 'today row for the big message');
  assert.equal(big.cacheWrite, 4e5, 'cacheWrite is the total of both tiers');
  assert.equal(big.total, 1e6 + 1e5 + 4e5 + 1e6);
  near(big.cost, 8.5);
});

test('AC12 unpriced models cost 0, are listed in unpricedModels, and do not break the total cost', async () => {
  const r = (await usage()).json;
  assert.ok(r.unpricedModels.some((m) => String(m).includes('mystery')), JSON.stringify(r.unpricedModels));
  assert.equal(r.unpricedModels.some((m) => String(m).includes('sonnet') || String(m).includes('opus')), false);
  const row = r.daily.find((x) => x.model.includes('mystery'));
  assert.equal(row.cost, 0);
  assert.equal(row.input, 5000);
  const todayRows = rows.filter((x) => localDay(x.ts) === localDay(new Date()));
  near(r.periods.today.cost, agg(todayRows).cost);
});

test('AC12 GET /api/prices returns the seeded table with the pinned row shape', async () => {
  const r = await S.api('GET', '/api/prices');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json) && r.json.length >= 12);
  const o = r.json.find((x) => x.model === 'claude-opus-5-5');
  assert.deepEqual([o.input, o.output, o.cacheWrite, o.cacheWrite1h, o.cacheRead], [4, 20, 5, 8, 0.2]);
  assert.equal(typeof o.note, 'string');
});

test('AC12 PUT /api/prices validates (400 + error, table unchanged) and the host/origin/content-type checks apply', async () => {
  const before = (await S.api('GET', '/api/prices')).json;
  const good = before[0];
  const bad = [
    { prices: 'nope' }, { prices: [{ ...good, input: -1 }] }, { prices: [{ ...good, output: 'x' }] }, { prices: [{ ...good, model: '' }] },
    { prices: [good, { ...good }] }, { prices: [{ ...good, cacheRead: null }] }, { nothing: 1 },
  ];
  for (const body of bad) {
    const r = await S.api('PUT', '/api/prices', { body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.equal(typeof r.json.error, 'string');
  }
  assert.deepEqual((await S.api('GET', '/api/prices')).json, before, 'a refused PUT changes nothing');
  assert.equal((await S.api('PUT', '/api/prices', { body: { prices: before }, headers: { Host: 'evil.example:80' } })).status, 403);
  assert.equal((await S.api('PUT', '/api/prices', { body: { prices: before }, headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await S.api('PUT', '/api/prices', { rawBody: JSON.stringify({ prices: before }), headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.deepEqual((await S.api('GET', '/api/prices')).json, before);
});

test('AC12 PUT /api/prices replaces the table; costs and unpricedModels follow it; the edit survives a round trip', async () => {
  const before = (await S.api('GET', '/api/prices')).json;
  const priced = [...before, { model: 'claude-mystery', input: 1, output: 2, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, note: 'test' }];
  const put = await S.api('PUT', '/api/prices', { body: { prices: priced } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.json, (await S.api('GET', '/api/prices')).json);
  assert.equal(put.json.find((x) => x.model === 'claude-mystery').note, 'test');
  const r = (await usage()).json;
  assert.equal(r.unpricedModels.some((m) => String(m).includes('mystery')), false);
  const row = r.daily.find((x) => x.model.includes('mystery'));
  near(row.cost, (5000 * 1 + 500 * 2) / 1e6);
  // dropping the opus rows makes the big message fall back to nothing: unpriced, cost 0
  const noOpus = before.filter((x) => !x.model.startsWith('claude-opus'));
  assert.equal((await S.api('PUT', '/api/prices', { body: { prices: noOpus } })).status, 200);
  const r2 = (await usage()).json;
  assert.ok(r2.unpricedModels.some((m) => String(m).includes('opus')));
  assert.equal(r2.daily.find((x) => x.model.startsWith('claude-opus-5-5') && x.input >= 1e6).cost, 0);
  assert.equal((await S.api('PUT', '/api/prices', { body: { prices: before } })).status, 200);
});

test('AC11 with fewer than 30 days of data, avg30 divides by the days that have data and reports that count', async () => {
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'am-proj-'));
  const ts = [localAt(0, 9), localAt(3, 12), localAt(6, 12)].map((d, i) => ({ id: `f${i}`, ts: d, input: 300 * (i + 1) }));
  writeLines(mainFile(proj, 'sess-f'), ts.map((t) => tline({ id: t.id, ts: t.ts, session: 'sess-f', input: t.input, output: 0 })));
  const T = await boot({ projects: proj });
  try {
    const ok = await until(async () => (await req(T.port, 'GET', '/api/stats/usage')).json?.indexer?.messages === 3, 12000, 100);
    assert.ok(ok);
    const a = (await req(T.port, 'GET', '/api/stats/usage')).json.periods.avg30;
    assert.equal(a.days, 3);
    assert.ok(Math.abs(a.input - 600) <= 1, `avg input ${a.input}`);
  } finally { await T.srv.close(); }
});

test('AC11 an empty projects dir gives zero periods and an empty daily list, not an error', async () => {
  const T = await boot();
  try {
    const r = await req(T.port, 'GET', '/api/stats/usage');
    assert.equal(r.status, 200);
    assert.equal(r.json.periods.today.total, 0);
    assert.equal(r.json.periods.avg30.days, 0);
    assert.deepEqual(r.json.daily, []);
    assert.ok((await req(T.port, 'GET', '/api/stats/versions')).json.length >= 1, 'one published version, no finished runs');
  } finally { await T.srv.close(); }
});
