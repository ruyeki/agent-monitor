// Guards the Stats lines and donuts (#2249): line chart, donuts, Runs line, light tokens. Vitest + jsdom.
import fs from "node:fs";
import path from "node:path";
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCost, formatDuration, formatTokens } from '../src/lib/format.js';
import { StatsPage } from '../src/stats/StatsPage.jsx';
import { Monitor } from '../src/Monitor.jsx';
import * as hooks from '../src/hooks.js';
import * as chart from '../src/stats/chart.js';

const NOW = new Date(2026, 9, 27, 12, 0, 0);
const dayStr = (k) => { const d = new Date(2026, 9, 27 - k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const res = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost, unpriced: 0 });

// $ per million tokens: input, output, cacheWrite, cacheRead
const RATE = {
  'claude-opus-5-5-20261001': [4, 20, 5, 0.2], 'claude-opus-5-5': [4, 20, 5, 0.2], 'claude-opus-5': [5, 25, 6.25, 0.5],
  'claude-sonnet-5-5-20261001': [2, 10, 2.5, 0.2], 'claude-sonnet-4-6': [3, 15, 3.75, 0.3], 'claude-haiku-4-5-20251001': [1, 5, 1.25, 0.1],
  'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.01], 'claude-fable-5': [10, 50, 12.5, 1],
};
const LABEL = { 'claude-opus-5-5-20261001': 'Opus 5.5', 'claude-opus-5-5': 'Opus 5.5', 'claude-opus-5': 'Opus 5', 'claude-sonnet-5-5-20261001': 'Sonnet 5.5', 'claude-sonnet-4-6': 'Sonnet 4.6', 'claude-haiku-4-5-20251001': 'Haiku 4.5', 'claude-haiku-5-5': 'Haiku 5.5', 'claude-fable-5': 'Fable 5' };
const mk = (k, model, { input = 0, output = 0, cacheWrite = 0, cacheRead = 0 } = {}) => {
  const [ri, ro, rw, rr] = RATE[model];
  const costs = { input: (input * ri) / 1e6, output: (output * ro) / 1e6, cacheWrite: (cacheWrite * rw) / 1e6, cacheRead: (cacheRead * rr) / 1e6 };
  return { day: dayStr(k), model, input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost: costs.input + costs.output + costs.cacheWrite + costs.cacheRead, costs };
};
const ROWS = [
  mk(0, 'claude-opus-5-5-20261001', { input: 1e6, output: 2e5, cacheWrite: 5e5, cacheRead: 2e7 }),
  mk(0, 'claude-opus-5-5', { input: 1e5 }), // same label as the dated id: one series
  mk(0, 'claude-opus-5', { input: 3e5, output: 1e5, cacheRead: 5e6 }),
  mk(0, 'claude-sonnet-5-5-20261001', { input: 5e5, output: 1e5, cacheRead: 8e6 }),
  mk(0, 'claude-haiku-5-5', { input: 1e5, output: 5e4, cacheRead: 6e8 }),
  mk(1, 'claude-sonnet-4-6', { input: 4e5, output: 5e4, cacheRead: 2e6 }),
  mk(1, 'claude-fable-5', { input: 1e5, output: 5e4 }),
  mk(2, 'claude-haiku-4-5-20251001', { output: 4e4 }),
  mk(5, 'claude-opus-5-5-20261001', { input: 5e5, output: 1e5 }),
  mk(8, 'claude-opus-5', { output: 2e5 }),
  mk(20, 'claude-sonnet-5-5-20261001', { input: 1e6 }),
  mk(25, 'claude-haiku-5-5', { cacheRead: 1e8 }),
  mk(40, 'claude-opus-5-5-20261001', { input: 1e6, output: 1e5 }), // previous 30-day period
  mk(59, 'claude-sonnet-5-5-20261001', { input: 1e6 }), // the very first day of the previous 30-day period
  { ...mk(0, 'claude-opus-5', { input: 7777 }), provider: 'codex' },
];
const FIRST_DAY = dayStr(59);
const periods = () => ({ today: tk(1_234_567, 21.9), week: tk(2_000_000, 30.5), month: tk(3_000_000, 44), avg30: { ...tk(900_000, 3.2), days: 9 } });
const codex = () => ({ today: tk(5_100_000), week: tk(0), month: tk(0) });

const shown = (days) => ROWS.filter((r) => r.provider !== 'codex' && r.day >= dayStr(days - 1));
const byLabel = (rows, f) => { const m = new Map(); for (const r of rows) m.set(LABEL[r.model], (m.get(LABEL[r.model]) || 0) + f(r)); return m; };
const rank = (rows, metric) => {
  const cost = byLabel(rows, (r) => r.cost); const tok = byLabel(rows, (r) => r.total);
  const main = metric === 'cost' ? cost : tok; const other = metric === 'cost' ? tok : cost;
  return [...main.keys()].sort((a, b) => main.get(b) - main.get(a) || other.get(b) - other.get(a) || a.localeCompare(b)).map((l) => [l, main.get(l)]);
};

const versions = () => [
  { version: 3, publishedAt: '2026-10-25T10:00:00Z', finishedRuns: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0, nodes: [{ id: 'frame', name: 'Frame', runs: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0 }] },
  { version: 2, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 5, avgTokens: 150_000, avgCost: 2.5, avgDurationMs: 600_000, nodes: [
    { id: 'frame', name: 'Frame', runs: 5, avgTokens: 10_000, avgCost: 0.1, avgDurationMs: 60_000 },
    { id: 'plan', name: 'Plan', runs: 5, avgTokens: 50_000, avgCost: 0.9, avgDurationMs: 120_000 },
    { id: 'parallel', name: 'Parallel', runs: 5, avgTokens: 0, avgCost: 0, avgDurationMs: 0 },
    { id: 'verify', name: 'Verify', runs: 3, avgTokens: 90_000, avgCost: 1.5, avgDurationMs: 3_600_000 },
    { id: 'join', name: 'Join', runs: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0 },
  ] },
  { version: 1, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 2, avgTokens: 40_000, avgCost: 0.5, avgDurationMs: 90_000, nodes: [
    { id: 'frame', name: 'Frame', runs: 2, avgTokens: 40_000, avgCost: 0.5, avgDurationMs: 90_000 },
  ] },
];
const prices = () => [{ model: 'claude-opus-5', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' }];

const at = (k, h = 12) => new Date(2026, 9, 27 - k, h, 0, 0).toISOString();
const run = (id, status, k, durMin, round = 0) => ({ id, title: id, status, round, maxRounds: 5, createdAt: at(k, 9), endedAt: ['done', 'stopped'].includes(status) ? new Date(Date.parse(at(k, 9)) + durMin * 60000).toISOString() : null, updatedAt: at(k) });
const RUNS = [
  run('r1', 'done', 0, 10, 0), run('r2', 'done', 0, 20, 1), run('r3', 'done', 3, 40, 2), run('r4', 'stopped', 3, 5, 1),
  run('r5', 'active', 1, 0), run('r6', 'waiting', 2, 0), run('r7', 'done', 45, 99, 4), // r7 is outside 30 days
];

let usageOverride; let fetchMock; let store;
const usageBody = (days) => ({
  indexer: { files: 2, messages: 99, scanning: false, lastScanAt: '2026-10-27T11:59:00Z' },
  codex: codex(), periods: periods(), daily: usageOverride?.rows ? usageOverride.rows.filter((r) => r.day >= dayStr(days - 1)) : ROWS.filter((r) => r.day >= dayStr(days - 1)),
  unpricedModels: [], firstDay: usageOverride && 'firstDay' in usageOverride ? usageOverride.firstDay : FIRST_DAY,
});
const calls = (re) => fetchMock.mock.calls.filter(([u]) => re.test(String(u))).map(([u]) => String(u));
const usageCalls = () => calls(/^\/api\/stats\/usage/);

beforeEach(() => {
  usageOverride = null;
  store = new Map();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/stats/usage')) return res(usageBody(Number(/days=(\d+)/.exec(u)?.[1] ?? 90)));
    if (u === '/api/stats/versions') return res(usageOverride?.versions ?? versions());
    if (u === '/api/runs') return res(usageOverride?.runs ?? RUNS);
    if (u === '/api/prices' && opts.method === 'PUT') return res(JSON.parse(opts.body).prices);
    if (u === '/api/prices') return res(prices());
    return res({}, false, 404);
  });
  globalThis.fetch = fetchMock;
  try { localStorage.clear(); } catch { /* ignore */ }
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const open = async (props = {}) => {
  const r = render(<StatsPage {...props} />);
  await screen.findByLabelText('Usage summary');
  return r;
};
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));
const pressed = (group, name) => within(screen.getByRole('group', { name: group })).getByRole('button', { name }).getAttribute('aria-pressed');
const legend = () => within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((li) => li.textContent.trim());
const fillOf = (label) => { const r = document.querySelector(`rect[data-series="${label}"]`); return r && (r.getAttribute('fill') || r.style.fill); };
const tiles = () => Object.fromEntries([...document.querySelectorAll('section[aria-label="Usage summary"] .stat')].map((t) => [t.getAttribute('aria-label'), t]));
const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };

// ---------- helpers for the line and donut contracts
const num = (s) => (String(s).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
const pointsOf = (el) => { const n = num(el.getAttribute('d') || ''); const out = []; for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]); return out; };
const lineEls = (root = document) => [...root.querySelectorAll('path.series-line')];
const dailySec = () => document.querySelector('section.daily-chart');
const runsSec = () => screen.getByRole('region', { name: 'Runs' });
const spendSec = () => screen.getByRole('region', { name: 'Spend by model' });
const stageSec = () => screen.getByRole('region', { name: "Where a run's tokens go" });
const gridYs = (root) => [...root.querySelectorAll('line.grid')].map((l) => Number(l.getAttribute('y1')));
const axisLabels = (root) => [...root.querySelectorAll('svg text')].map((t) => t.textContent.trim()).filter((t) => /^[$\d]/.test(t));
const strokeOf = (el) => el.getAttribute('stroke') || el.style.stroke;
const fill = (el) => el.getAttribute('fill') || el.style.fill;
const opacityOf = (el) => { const v = el.getAttribute('opacity') || el.style.opacity || el.getAttribute('fill-opacity'); return v === '' || v === null || v === undefined ? 1 : Number(v); };
const hitsOf = (sel) => [...document.querySelectorAll(sel)];
const centreOf = (sec) => { const svg = sec.querySelector('svg'); const c = (svg.closest('.donut') || svg.parentElement).cloneNode(true); c.querySelectorAll('ol, ul, table, title, .sr-only').forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); };
const slices = (sec) => [...sec.querySelectorAll('path[data-slice]')];
const sliceKeys = (sec) => slices(sec).map((s) => s.getAttribute('data-slice'));
const cur = (rows, days, metric = 'cost') => rows.filter((r) => r.provider !== 'codex' && r.day >= dayStr(days - 1)).reduce((a, r) => a + (metric === 'cost' ? r.cost : r.total), 0);
const colCenter = (hit) => Number(hit.getAttribute('x')) + Number(hit.getAttribute('width')) / 2;
const lineOf = (key) => dailySec().querySelector(`path.series-line[data-series="${key}"]`);

// expected per-series per-day values for the model split of the shown range
const expectedLines = (metric = 'cost', days = 30) => {
  const rows = shown(days);
  const top = rank(rows, metric).slice(0, 5).map(([l]) => l);
  const keyOf = (l) => (top.includes(l) ? l : 'Other');
  const m = new Map();
  for (const r of rows) { const k = keyOf(LABEL[r.model]); const d = m.get(k) ?? new Map(); d.set(r.day, (d.get(r.day) || 0) + (metric === 'cost' ? r.cost : r.total)); m.set(k, d); }
  return { top, byKey: m };
};

describe('daily chart is lines', () => {
  it('no stacked rects; one 2px unfilled line per legend series with the series colour; svg label says lines', async () => {
    await open();
    expect(document.querySelectorAll('rect[data-series], rect[data-day]')).toHaveLength(0);
    const lg = legend();
    const els = lineEls(dailySec());
    expect(els.map((e) => e.getAttribute('data-series')).sort()).toEqual([...lg].sort());
    for (const e of els) {
      expect(e.getAttribute('fill')).toBe('none');
      expect(Number(e.getAttribute('stroke-width') || e.style.strokeWidth)).toBe(2);
      expect(e.getAttribute('stroke-linejoin') || e.style.strokeLinejoin).toBe('round');
      expect(e.getAttribute('stroke-linecap') || e.style.strokeLinecap).toBe('round');
      expect(strokeOf(e)).toMatch(/^var\(--series-(\d|other)\)$/);
    }
    expect(new Set(els.map(strokeOf)).size).toBe(els.length);
    expect(strokeOf(lineOf('Other'))).toBe('var(--series-other)');
    expect(document.querySelector('.daily-chart svg[role="img"]').getAttribute('aria-label')).toMatch(/^Lines of daily cost over the last 30 days, .+ in total\. The table below has the numbers\.$/);
    expect(document.querySelectorAll('section.daily-chart rect[data-hit]')).toHaveLength(30);
  });

  it('draw order: Other first, rank 1 last (on top)', async () => {
    await open();
    const order = lineEls(dailySec()).map((e) => e.getAttribute('data-series'));
    expect(order).toEqual([...legend()].reverse());
    expect(order[0]).toBe('Other');
    expect(order.at(-1)).toBe('Opus 5.5');
  });

  it('a point per shown day at the column centre, zero days at the baseline, scaled to the largest SINGLE series (not the stack)', async () => {
    await open();
    const sec = dailySec();
    const ys = gridYs(sec);
    const base = Math.max(...ys); const topY = Math.min(...ys);
    const { byKey } = expectedLines('cost');
    let max = 0; for (const d of byKey.values()) for (const v of d.values()) max = Math.max(max, v);
    const ticks = chart.niceTicks(max);
    expect(ys).toHaveLength(ticks.length);
    expect(axisLabels(sec)).toContain(chart.compactCost(ticks.at(-1)));
    const days = Array.from({ length: 30 }, (_, i) => dayStr(29 - i));
    const hits = hitsOf('section.daily-chart rect[data-hit]');
    for (const e of lineEls(sec)) {
      const key = e.getAttribute('data-series');
      const p = pointsOf(e);
      expect(p, key).toHaveLength(30);
      p.forEach(([x, y], i) => {
        expect(Math.abs(x - colCenter(hits[i])), `${key} x ${i}`).toBeLessThan(0.75);
        const v = byKey.get(key)?.get(days[i]) || 0;
        const got = ((base - y) / (base - topY)) * ticks.at(-1);
        if (v === 0) expect(Math.abs(y - base), `${key} zero day ${days[i]}`).toBeLessThan(0.75);
        expect(Math.abs(got - v), `${key} ${days[i]} value`).toBeLessThanOrEqual(ticks.at(-1) * 0.012);
      });
    }
  });

  it('Tokens mode and the type split keep the same line rules (axis from the largest single series)', async () => {
    await open();
    press('Tokens');
    await settle();
    expect(document.querySelector('.daily-chart svg[role="img"]').getAttribute('aria-label')).toMatch(/^Lines of daily tokens over the last 30 days/);
    const { byKey } = expectedLines('tokens');
    let max = 0; for (const d of byKey.values()) for (const v of d.values()) max = Math.max(max, v);
    const ticks = chart.niceTicks(max);
    expect(axisLabels(dailySec())).toContain(formatTokens(ticks.at(-1)));
    expect(gridYs(dailySec())).toHaveLength(ticks.length);
    press('By token type');
    await settle();
    const els = lineEls(dailySec());
    expect(els.map((e) => e.getAttribute('data-series'))).toEqual(['cacheRead', 'cacheWrite', 'output', 'input']);
    expect(els.map(strokeOf)).toEqual(['var(--series-4)', 'var(--series-3)', 'var(--series-2)', 'var(--series-1)']);
    expect(document.querySelectorAll('rect[data-series]')).toHaveLength(0);
  });

  it('hover or focus a day: guide at the column, one ringed dot per series with a value on the line, tooltip sorted by value with shares', async () => {
    await open();
    const sec = dailySec();
    expect(sec.querySelector('line.guide')).toBeNull();
    expect(sec.querySelector('circle.dot')).toBeNull();
    const hits = hitsOf('section.daily-chart rect[data-hit]');
    const hit = hits.find((h) => h.getAttribute('data-hit') === dayStr(1)); // Sonnet 4.6 (folded into Other) and Fable 5 only
    const topKeys = expectedLines('cost').top;
    const keyFor = (l) => (topKeys.includes(l) ? l : 'Other');
    const dayRows = ROWS.filter((r) => r.provider !== 'codex' && r.day === dayStr(1));
    const expKeys = [...new Set(dayRows.map((r) => keyFor(LABEL[r.model])))];
    fireEvent.mouseEnter(hit);
    const guide = sec.querySelector('line.guide');
    expect(guide).toBeTruthy();
    expect(Math.abs(Number(guide.getAttribute('x1')) - colCenter(hit))).toBeLessThan(0.75);
    expect(guide.getAttribute('x1')).toBe(guide.getAttribute('x2'));
    const dots = [...sec.querySelectorAll('circle.dot')];
    expect(dots.map((d) => d.getAttribute('data-dot')).sort()).toEqual([...expKeys].sort());
    for (const d of dots) {
      expect(Number(d.getAttribute('r'))).toBe(4);
      expect(fill(d)).toBe(strokeOf(lineOf(d.getAttribute('data-dot'))));
      expect(d.getAttribute('stroke') || d.style.stroke).toMatch(/--surface\)/);
      expect(Number(d.getAttribute('stroke-width') || d.style.strokeWidth)).toBe(2);
      const pt = pointsOf(lineOf(d.getAttribute('data-dot')))[hits.indexOf(hit)];
      expect(Math.abs(Number(d.getAttribute('cx')) - pt[0])).toBeLessThan(0.75);
      expect(Math.abs(Number(d.getAttribute('cy')) - pt[1])).toBeLessThan(0.75);
    }
    const tip = document.querySelector('.tooltip[role="status"]').textContent;
    const rows = ROWS.filter((r) => r.provider !== 'codex' && r.day === dayStr(1));
    const total = rows.reduce((a, r) => a + r.cost, 0);
    expect(tip).toContain('Oct 26');
    expect(tip).toContain(formatCost(total));
    const m = new Map();
    for (const r of rows) m.set(keyFor(LABEL[r.model]), (m.get(keyFor(LABEL[r.model])) || 0) + r.cost);
    const order = [...tip.matchAll(new RegExp(`(${expKeys.join('|')}): `, 'g'))].map((x) => x[1]);
    expect(order).toEqual([...m.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l));
    for (const [l, v] of m) expect(tip).toMatch(new RegExp(`${l}: ${formatCost(v).replace(/[$.]/g, '\\$&')} \\(${Math.round((v / total) * 100)}%\\)`));
    expect(tip).not.toMatch(/Opus|Haiku|Sonnet 5/);
    fireEvent.mouseLeave(hit);
    expect(sec.querySelector('line.guide')).toBeNull();
    expect(sec.querySelector('circle.dot')).toBeNull();
  });

  it('a day with no usage shows the guide but no dots; the busiest day lists series largest first', async () => {
    await open();
    const sec = dailySec();
    fireEvent.mouseEnter(document.querySelector(`section.daily-chart rect[data-hit="${dayStr(3)}"]`));
    expect(sec.querySelector('line.guide')).toBeTruthy();
    expect(sec.querySelectorAll('circle.dot')).toHaveLength(0);
    fireEvent.mouseEnter(document.querySelector(`section.daily-chart rect[data-hit="${dayStr(0)}"]`));
    expect(sec.querySelectorAll('circle.dot').length).toBeGreaterThanOrEqual(4);
    const tip = document.querySelector('.tooltip').textContent;
    const vals = [...tip.matchAll(/: (?:\$([\d,]+\.\d\d)|<\$0\.01)/g)].map((x) => Number((x[1] || '0').replace(/,/g, '')));
    expect(vals.length).toBeGreaterThanOrEqual(4);
    vals.forEach((v, i) => { if (i) expect(vals[i - 1]).toBeGreaterThanOrEqual(v); });
  });

  it('arrow keys move the guide with focus', async () => {
    await open();
    const hits = hitsOf('section.daily-chart rect[data-hit]');
    act(() => hits[10].focus());
    fireEvent.focus(hits[10]);
    const x0 = Number(dailySec().querySelector('line.guide').getAttribute('x1'));
    fireEvent.keyDown(hits[10], { key: 'ArrowRight' });
    const x1 = Number(dailySec().querySelector('line.guide').getAttribute('x1'));
    expect(Math.abs(x1 - colCenter(hits[11]))).toBeLessThan(0.75);
    expect(x1).toBeGreaterThan(x0);
    fireEvent.keyDown(hits[11], { key: 'Escape' });
    expect(dailySec().querySelector('line.guide')).toBeNull();
  });
});

describe('Runs per day is a line', () => {
  it('one 2px line in series-1, a point per day, zero days at 0, integer axis, no bars', async () => {
    await open();
    const sec = runsSec();
    expect(sec.querySelectorAll('rect[data-run-day]')).toHaveLength(0);
    const ln = sec.querySelectorAll('path.series-line');
    expect(ln).toHaveLength(1);
    const e = ln[0];
    expect(e.getAttribute('data-series')).toBe('runs');
    expect(strokeOf(e)).toBe('var(--series-1)');
    expect(Number(e.getAttribute('stroke-width') || e.style.strokeWidth)).toBe(2);
    expect(e.getAttribute('fill')).toBe('none');
    const p = pointsOf(e);
    expect(p).toHaveLength(30);
    const ys = gridYs(sec); const base = Math.max(...ys); const topY = Math.min(...ys);
    const labels = axisLabels(sec);
    expect(labels.length).toBeGreaterThanOrEqual(3);
    expect(labels.every((t) => /^\d+$/.test(t))).toBe(true);
    const topTick = Math.max(...labels.map(Number));
    expect(topTick).toBeGreaterThanOrEqual(2);
    const counts = { [dayStr(0)]: 2, [dayStr(1)]: 1, [dayStr(2)]: 1, [dayStr(3)]: 2 };
    const days = Array.from({ length: 30 }, (_, i) => dayStr(29 - i));
    p.forEach(([, y], i) => {
      const v = counts[days[i]] || 0;
      expect(Math.abs(((base - y) / (base - topY)) * topTick - v), days[i]).toBeLessThan(0.05 * topTick);
    });
  });

  it('hover or keys: guide, one dot on the line, tooltip with the run count; singular for one run', async () => {
    await open();
    const sec = runsSec();
    const hits = hitsOf('rect[data-run-hit]');
    expect(hits).toHaveLength(30);
    const h3 = hits.find((h) => h.getAttribute('data-run-hit') === dayStr(3));
    fireEvent.mouseEnter(h3);
    expect(sec.querySelector('line.guide')).toBeTruthy();
    expect(sec.querySelectorAll('circle.dot')).toHaveLength(1);
    expect(sec.querySelector('.tooltip').textContent).toMatch(/Oct 24 · 2 runs/);
    const h1 = hits.find((h) => h.getAttribute('data-run-hit') === dayStr(1));
    fireEvent.mouseEnter(h1);
    expect(sec.querySelector('.tooltip').textContent).toMatch(/Oct 26 · 1 run(?!s)/);
    const cy = Number(sec.querySelector('circle.dot').getAttribute('cy'));
    expect(Math.abs(cy - pointsOf(sec.querySelector('path.series-line'))[hits.indexOf(h1)][1])).toBeLessThan(0.75);
    act(() => h1.focus());
    fireEvent.keyDown(h1, { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(hits[hits.indexOf(h1) - 1]);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(sec.querySelector('.tooltip')).toBeNull();
  });

  it('keeps the outcome counts, median duration, average fix rounds and the sr-only table', async () => {
    await open();
    const sec = runsSec();
    expect(sec.querySelector('[data-outcome="finished"]').textContent).toMatch(/3/);
    expect(sec.querySelector('[data-outcome="stopped"]').textContent).toMatch(/1/);
    expect(sec.querySelector('[data-outcome="open"]').textContent).toMatch(/2/);
    expect(within(sec).getByRole('table', { name: 'Runs per day table' })).toBeTruthy();
    expect(sec.textContent).toMatch(/Median duration/);
    expect(sec.textContent).toMatch(/Avg fix rounds/);
  });

  it('no data-mark rects anywhere on the page: every rect is a hit area; no bar markup', async () => {
    await open();
    const all = [...document.querySelectorAll('rect')];
    expect(all.length).toBe(60);
    expect(all.every((r) => r.hasAttribute('data-hit') || r.hasAttribute('data-run-hit'))).toBe(true);
    expect(document.querySelectorAll('.bar-row, .bar-fill, .bar-track')).toHaveLength(0);
  });
});

describe('Spend by model is a donut', () => {
  it('slices in rank order with Other last; legend rows match; same members and colours as the line chart', async () => {
    await open();
    const sec = spendSec();
    const ks = sliceKeys(sec);
    expect(ks).toHaveLength(6);
    expect(ks.at(-1)).toBe('Other');
    const { top } = expectedLines('cost');
    expect(ks.slice(0, 5)).toEqual(top);
    const ol = within(sec).getByRole('list', { name: 'Models ranked by cost' });
    const rows = [...ol.querySelectorAll('li[data-model]')];
    expect(rows.map((r) => r.getAttribute('data-model'))).toEqual(ks);
    expect(rows.at(-1).textContent).toMatch(/Other \(2 models\)/);
    for (const r of rows.slice(0, 5)) expect(r.textContent).toMatch(/\$\d/);
    for (const r of rows) expect(r.textContent).toMatch(/\d+(\.\d)?%/);
    expect(sec.querySelectorAll('.bar-row, .bar-fill, rect')).toHaveLength(0);
    const cols = Object.fromEntries(slices(sec).map((s) => [s.getAttribute('data-slice'), fill(s)]));
    for (const e of lineEls(dailySec())) expect(cols[e.getAttribute('data-series')], e.getAttribute('data-series')).toBe(strokeOf(e));
    expect(cols.Other).toBe('var(--series-other)');
  });

  it('centre shows the range total and "in 30 days"; slices carry label, value and share; ring + group labels', async () => {
    await open();
    const sec = spendSec();
    expect(centreOf(sec)).toContain(formatCost(cur(ROWS, 30)));
    expect(centreOf(sec)).toMatch(/in 30 days/);
    const svg = sec.querySelector('svg');
    expect(svg.getAttribute('role')).toBe('group');
    expect(svg.getAttribute('aria-label')).toMatch(/in total\. The list beside it has the numbers\.$/);
    expect(svg.getAttribute('aria-label')).toContain(formatCost(cur(ROWS, 30)));
    const sum = slices(sec).map((s) => { const m = /^(.+): (.+) \((\d+(?:\.\d)?)%\)$/.exec(s.getAttribute('aria-label')); expect(m, s.getAttribute('aria-label')).toBeTruthy(); return Number(m[3]); });
    expect(Math.abs(sum.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(3);
    expect(sec.querySelectorAll('path[data-slice][tabindex="0"]')).toHaveLength(1);
  });

  it("first slice starts at 12 o'clock", async () => {
    await open();
    const svg = spendSec().querySelector('svg');
    const vb = num(svg.getAttribute('viewBox'));
    const cx = vb[2] / 2; const cy = vb[3] / 2;
    const [x, y] = pointsOf(slices(spendSec())[0])[0];
    expect(Math.abs(x - cx)).toBeLessThan(vb[2] * 0.08);
    expect(y).toBeLessThan(cy - vb[3] * 0.2);
  });

  it('hover or focus a slice, or hover its legend row: others dim to 0.35, row active, centre swaps to that slice', async () => {
    await open();
    const sec = spendSec();
    const sl = slices(sec);
    const row = (k) => sec.querySelector(`li[data-model="${k}"]`);
    const ks = sliceKeys(sec);
    fireEvent.mouseEnter(sl[1]);
    expect(opacityOf(sl[1])).toBe(1);
    expect(opacityOf(sl[0])).toBe(0.35);
    expect(row(ks[1]).classList.contains('active')).toBe(true);
    expect(row(ks[0]).classList.contains('active')).toBe(false);
    const v = centreOf(sec);
    expect(v).toContain(ks[1]);
    expect(v).toMatch(/\d+(\.\d)?%/);
    expect(v).not.toMatch(/in 30 days/);
    fireEvent.mouseLeave(sl[1]);
    expect(opacityOf(sl[0])).toBe(1);
    expect(centreOf(sec)).toMatch(/in 30 days/);
    fireEvent.mouseEnter(row(ks[2]));
    expect(opacityOf(sl[2])).toBe(1);
    expect(opacityOf(sl[3])).toBe(0.35);
    expect(row(ks[2]).classList.contains('active')).toBe(true);
    expect(centreOf(sec)).toContain(ks[2]);
    fireEvent.mouseLeave(row(ks[2]));
    expect(sl.every((s) => opacityOf(s) === 1)).toBe(true);
    fireEvent.focus(sl[4]);
    expect(opacityOf(sl[0])).toBe(0.35);
    expect(centreOf(sec)).toContain(ks[4]);
    fireEvent.blur(sl[4]);
    expect(centreOf(sec)).toMatch(/in 30 days/);
  });

  it('arrow keys, Home/End and Escape on the ring', async () => {
    await open();
    const sec = spendSec();
    const sl = slices(sec);
    const tab = sl.find((s) => s.getAttribute('tabindex') === '0');
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: 'Home' });
    expect(document.activeElement).toBe(sl[0]);
    fireEvent.keyDown(sl[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(sl[1]);
    fireEvent.keyDown(sl[1], { key: 'ArrowDown' });
    expect(document.activeElement).toBe(sl[2]);
    fireEvent.keyDown(sl[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(sl[1]);
    fireEvent.keyDown(sl[1], { key: 'ArrowUp' });
    expect(document.activeElement).toBe(sl[0]);
    fireEvent.keyDown(sl[0], { key: 'End' });
    expect(document.activeElement).toBe(sl.at(-1));
    expect(centreOf(sec)).toContain('Other');
    expect(sec.querySelectorAll('path[data-slice][tabindex="0"]')).toHaveLength(1);
    fireEvent.keyDown(sl.at(-1), { key: 'Escape' });
    expect(centreOf(sec)).toMatch(/in 30 days/);
    expect(sl.every((s) => opacityOf(s) === 1)).toBe(true);
  });

  it('follows the metric and the range; 7 days still agrees with the line chart', async () => {
    await open();
    press('Tokens');
    await settle();
    const sec = spendSec();
    expect(within(sec).getByRole('list', { name: 'Models ranked by tokens' })).toBeTruthy();
    expect(centreOf(sec)).toContain(formatTokens(cur(ROWS, 30, 'tokens')));
    const { top } = expectedLines('tokens');
    expect(sliceKeys(sec).slice(0, 5)).toEqual(top);
    press('7 days');
    await settle();
    await screen.findByLabelText('Usage summary');
    expect(centreOf(spendSec())).toMatch(/in 7 days/);
    const legendKeys = legend().filter((l) => l !== 'Other');
    expect(sliceKeys(spendSec()).filter((k) => k !== 'Other')).toEqual(legendKeys);
    for (const e of lineEls(dailySec())) expect(fill(spendSec().querySelector(`path[data-slice="${e.getAttribute('data-series')}"]`))).toBe(strokeOf(e));
  });

  it('five or fewer models: no Other slice; a tiny model still gets a visible sliver', async () => {
    usageOverride = { rows: [mk(0, 'claude-opus-5', { input: 1e6 }), mk(0, 'claude-sonnet-4-6', { input: 3e5 }), mk(0, 'claude-haiku-5-5', { input: 4000 })] };
    await open();
    const sec = spendSec();
    expect(sliceKeys(sec)).toEqual(['Opus 5', 'Sonnet 4.6', 'Haiku 5.5']);
    expect(within(sec).queryByText(/^Other/)).toBeNull();
    const tiny = slices(sec).at(-1);
    const share = Number(/\((\d+(?:\.\d)?)%\)$/.exec(tiny.getAttribute('aria-label'))[1]);
    expect(share).toBeLessThan(0.5);
    const a = /A\s*([-\d.,\s e]+)/i.exec(tiny.getAttribute('d'));
    expect(a, 'arc command in the sliver path').toBeTruthy();
    const an = num(a[1]);
    const m = pointsOf(tiny)[0];
    expect(Math.hypot(an[5] - m[0], an[6] - m[1])).toBeGreaterThan(1);
  });

  it('a single model fills the ring', async () => {
    usageOverride = { rows: [mk(0, 'claude-opus-5', { input: 1e6 })] };
    await open();
    const sec = spendSec();
    expect(sliceKeys(sec)).toEqual(['Opus 5']);
    expect(centreOf(sec)).toContain('$5.00');
    expect(sec.querySelector('path[data-slice]').getAttribute('d').length).toBeGreaterThan(10);
  });
});

// ---------- stage donut
const node = (id, runs, avgCost, avgTokens, dur = 60_000) => ({ id, name: `Stage ${id.slice(1)}`, runs, avgCost, avgTokens, avgDurationMs: dur });
const stageVersion = (nodes, over = {}) => ({ version: 1, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 10, avgTokens: 100_000, avgCost: 10, avgDurationMs: 600_000, nodes, ...over });
const NINE = [
  node('n1', 10, 2.0, 5000), node('n2', 10, 1.5, 30000), node('n3', 5, 2.0, 40000, 120_000), node('n4', 10, 0.8, 15000),
  node('n5', 10, 0.6, 10000), node('n6', 10, 0.5, 2500), node('n7', 10, 0.3, 3000), node('n8', 10, 0.2, 2000), node('n9', 10, 0.1, 1000),
  node('n10', 0, 0, 0), // never ran: skipped
];
const pr = (n) => (n.avgCost * n.runs) / 10;
const sl = (k) => stageSec().querySelector(`path[data-slice="${k}"]`);
const stRow = (k) => stageSec().querySelector(`li[data-stage="${k}"]`);
const lbl = (s) => /^(.+): (.+) \((\d+(?:\.\d)?)%\)$/.exec(s.getAttribute('aria-label'));

describe("Where a run's tokens go is a donut", () => {
  it('9 stages: 6 largest + "Other stages" + "Not tied to a stage"; workflow order; per-run values; centre = run average', async () => {
    usageOverride = { versions: [stageVersion(NINE)] };
    await open();
    const sec = stageSec();
    expect(sliceKeys(sec)).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'other-stages', 'not-staged']);
    expect(centreOf(sec)).toContain(formatCost(10));
    expect(centreOf(sec)).toMatch(/per run/);
    const ol = within(sec).getByRole('list', { name: 'Stages' });
    expect([...ol.querySelectorAll('li[data-stage]')].map((e) => e.getAttribute('data-stage'))).toEqual(sliceKeys(sec));
    expect(sec.querySelectorAll('rect, .bar-row, .bar-fill')).toHaveLength(0);
    for (const n of NINE.slice(0, 6)) {
      const m = lbl(sl(n.id));
      expect(m[1]).toBe(n.name);
      expect(m[2]).toBe(formatCost(pr(n)));
      expect(Math.abs(Number(m[3]) - (pr(n) / 10) * 100)).toBeLessThanOrEqual(1);
      expect(stRow(n.id).textContent).toContain(n.name);
      expect(stRow(n.id).textContent).toContain(formatCost(pr(n)));
      expect(stRow(n.id).textContent).toContain(formatDuration(n.avgDurationMs));
    }
    expect(lbl(sl('other-stages'))[1]).toBe('Other stages');
    expect(lbl(sl('other-stages'))[2]).toBe(formatCost(0.6));
    expect(lbl(sl('not-staged'))[1]).toBe('Not tied to a stage');
    expect(lbl(sl('not-staged'))[2]).toBe(formatCost(3));
    expect(stRow('n10')).toBeNull();
    expect(stRow('n7')).toBeNull(); // folded
    expect(stRow('n3').textContent).toMatch(/5 of 10 runs/);
    expect(stRow('n1').textContent).not.toMatch(/of 10 runs/);
    expect(stRow('other-stages').textContent).toContain('Other stages');
    expect(stRow('not-staged').textContent).toContain('Not tied to a stage');
    const shares = slices(sec).map((s) => Number(lbl(s)[3]));
    expect(Math.abs(shares.reduce((a, b) => a + b, 0) - 100)).toBeLessThanOrEqual(3);
  });

  it('colours follow the stage by cost rank; Other stages is --series-other; the remainder is --border-strong', async () => {
    usageOverride = { versions: [stageVersion(NINE)] };
    await open();
    ['n1', 'n2', 'n3', 'n4', 'n5', 'n6'].forEach((k, i) => expect(fill(sl(k)), k).toBe(`var(--series-${i + 1})`));
    expect(fill(sl('other-stages'))).toBe('var(--series-other)');
    expect(fill(sl('not-staged'))).toBe('var(--border-strong)');
    press('Tokens');
    await settle();
    // tokens mode: the 6 largest by per-run tokens (n6 drops out, n7 comes in); colours keep following the stage
    expect(sliceKeys(stageSec())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n7', 'other-stages', 'not-staged']);
    expect(fill(sl('n1'))).toBe('var(--series-1)');
    expect(fill(sl('n3'))).toBe('var(--series-3)');
    expect(fill(sl('n7'))).toBe('var(--series-7)');
    expect(centreOf(stageSec())).toContain(formatTokens(100_000));
    expect(lbl(sl('n3'))[2]).toContain(formatTokens(20_000));
    expect(lbl(sl('not-staged'))[2]).toContain(formatTokens(11_500));
  });

  it('exactly 7 stages keep all seven (no Other stages)', async () => {
    usageOverride = { versions: [stageVersion(NINE.slice(0, 7))] };
    await open();
    expect(sliceKeys(stageSec())).toEqual(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'not-staged']);
    expect(stRow('other-stages')).toBeNull();
  });

  it('a remainder of 0.3% is hidden', async () => {
    const seven = [node('a1', 10, 3, 1), node('a2', 10, 2, 1), node('a3', 10, 1.5, 1), node('a4', 10, 1.2, 1), node('a5', 10, 1, 1), node('a6', 10, 0.7, 1), node('a7', 10, 0.57, 1)];
    usageOverride = { versions: [stageVersion(seven, { avgTokens: 7 })] };
    await open();
    expect(sliceKeys(stageSec())).toEqual(['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']);
    expect(stRow('not-staged')).toBeNull();
  });

  it('a remainder of 1% is shown, last, and does not count toward the 7', async () => {
    const six = [node('b1', 10, 4, 1), node('b2', 10, 3, 1), node('b3', 10, 2, 1), node('b4', 10, 0.4, 1), node('b5', 10, 0.2, 1), node('b6', 10, 0.2, 1), node('b7', 10, 0.1, 1)];
    usageOverride = { versions: [stageVersion(six, { avgTokens: 7 })] }; // sum 9.9 of 10
    await open();
    expect(sliceKeys(stageSec())).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6', 'b7', 'not-staged']);
  });

  it('hover or focus a slice or legend row: dim, active row, centre swaps; keys rove; Escape clears', async () => {
    usageOverride = { versions: [stageVersion(NINE)] };
    await open();
    const sec = stageSec();
    const all = slices(sec);
    fireEvent.mouseEnter(all[2]);
    expect(opacityOf(all[2])).toBe(1);
    expect(opacityOf(all[0])).toBe(0.35);
    expect(stRow('n3').classList.contains('active')).toBe(true);
    const c = centreOf(sec);
    expect(c).toContain('Stage 3');
    expect(c).toContain(formatCost(1));
    expect(c).toMatch(/10%/);
    expect(c).not.toMatch(/per run/);
    fireEvent.mouseLeave(all[2]);
    fireEvent.mouseEnter(stRow('not-staged'));
    expect(centreOf(sec)).toContain('Not tied to a stage');
    expect(opacityOf(sl('n1'))).toBe(0.35);
    fireEvent.mouseLeave(stRow('not-staged'));
    expect(centreOf(sec)).toMatch(/per run/);
    expect(all.filter((s) => s.getAttribute('tabindex') === '0')).toHaveLength(1);
    const tab = all.find((s) => s.getAttribute('tabindex') === '0');
    act(() => tab.focus());
    fireEvent.keyDown(tab, { key: 'Home' });
    expect(document.activeElement).toBe(all[0]);
    fireEvent.keyDown(all[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(all[1]);
    fireEvent.keyDown(all[1], { key: 'End' });
    expect(document.activeElement).toBe(all.at(-1));
    fireEvent.keyDown(all.at(-1), { key: 'Escape' });
    expect(centreOf(sec)).toMatch(/per run/);
    expect(all.every((s) => opacityOf(s) === 1)).toBe(true);
    expect(sec.querySelector('svg').getAttribute('role')).toBe('group');
    expect(sec.querySelector('svg').getAttribute('aria-label')).toMatch(/in total\. The list beside it has the numbers\.$/);
  });

  it('keeps the version toggle, the summary line and the versions table; switching version redraws the donut', async () => {
    const v2 = stageVersion([node('p1', 4, 3, 30000), node('p2', 4, 1, 10000)], { version: 2, finishedRuns: 4, avgCost: 5, avgTokens: 50_000 });
    usageOverride = { versions: [v2, stageVersion(NINE)] };
    await open();
    const sec = stageSec();
    expect(within(sec).getByRole('group', { name: 'Version' })).toBeTruthy();
    expect(sliceKeys(sec)).toEqual(['p1', 'p2', 'not-staged']); // 3 + 1 of 5 per run, 1 left over
    expect(within(sec).getByRole('table', { name: 'Workflow versions' })).toBeTruthy();
    expect(sec.textContent).toMatch(/4 finished runs · avg 50k tokens/);
    fireEvent.click(within(sec).getByRole('button', { name: 'v1' }));
    expect(sliceKeys(sec)).toContain('other-stages');
    expect(sec.textContent).toMatch(/10 finished runs/);
  });

  it('a version without finished runs and no versions at all say so and draw no donut', async () => {
    usageOverride = { versions: [{ ...stageVersion([node('c1', 0, 0, 0)]), finishedRuns: 0 }] };
    const r = await open();
    expect(stageSec().textContent).toMatch(/No finished runs on v1 yet\./);
    expect(stageSec().querySelectorAll('path[data-slice]')).toHaveLength(0);
    r.unmount();
    usageOverride = { versions: [] };
    await open();
    expect(stageSec().textContent).toMatch(/No published versions yet\./);
  });
});

// ---------- tokens
const css = fs.readFileSync(path.join(process.cwd(), 'src', 'styles.css'), 'utf8');
const seriesHex = (n) => [...css.matchAll(new RegExp(`--series-${n}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1].toLowerCase());
const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const rgb = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const lum = (h) => { const [r, g, b] = rgb(h).map(lin); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
const ratio = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
const lab = (h) => { const [r, g, b] = rgb(h).map(lin); const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047; const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b; const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883; const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))]; };
const dE = (a, b) => Math.hypot(...lab(a).map((v, i) => v - lab(b)[i]));
const LIGHT_NEW = { 3: '#0f8c7e', 4: '#9c7400', 5: '#c44f7c' };
const LIGHT_KEPT = { 1: '#2a78d6', 2: '#eb6834', 6: '#008300', 7: '#6250d6', 8: '#e34948', other: '#8a93a3' };
const DARK = { 1: '#3987e5', 2: '#d95926', 3: '#199e70', 4: '#c98500', 5: '#d55181', 6: '#008300', 7: '#9085e9', 8: '#e66767', other: '#7b8494' };

describe('series tokens', () => {
  it('light slots 3-5 use the new hues, the other light slots stay, and every light slot is >= 3:1 on white', () => {
    const light = Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 'other'].map((n) => [n, seriesHex(n)[0]]));
    for (const [n, h] of Object.entries(LIGHT_NEW)) expect(light[n], `light --series-${n}`).toBe(h);
    for (const [n, h] of Object.entries(LIGHT_KEPT)) expect(light[n], `light --series-${n}`).toBe(h);
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8]) expect(ratio(light[n], '#ffffff'), `slot ${n}`).toBeGreaterThanOrEqual(3);
  });

  it('light slots stay distinguishable from each other (CIE76 distance >= 20)', () => {
    const light = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => seriesHex(n)[0]);
    for (let i = 0; i < light.length; i++) for (let j = i + 1; j < light.length; j++) expect(dE(light[i], light[j]), `${i + 1}/${j + 1}`).toBeGreaterThanOrEqual(20);
  });

  it('the bar styles are gone from the stylesheet', () => {
    expect(css).not.toMatch(/\.bar-fill|\.bar-track|\.bar-row/);
  });
});
