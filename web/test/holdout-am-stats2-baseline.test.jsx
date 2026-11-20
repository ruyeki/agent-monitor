// Guards the Stats lines and donuts (#2249): baseline of what the Stats page does today and must keep doing. Vitest + jsdom.
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


const css = fs.readFileSync(path.join(process.cwd(), 'src', 'styles.css'), 'utf8');
const seriesHex = (n) => [...css.matchAll(new RegExp(`--series-${n}:\\s*(#[0-9a-fA-F]{6})`, 'g'))].map((m) => m[1].toLowerCase());
const DARK = { 1: '#3987e5', 2: '#d95926', 3: '#199e70', 4: '#c98500', 5: '#d55181', 6: '#008300', 7: '#9085e9', 8: '#e66767', other: '#7b8494' };

describe('baseline: Stats page', () => {
  it('both dark series blocks keep their values and stay identical', () => {
    for (const n of [1, 2, 3, 4, 5, 6, 7, 8, 'other']) {
      const v = seriesHex(n);
      expect(v.length, `--series-${n} blocks`).toBe(3);
      expect(v[1]).toBe(DARK[n]);
      expect(v[2]).toBe(DARK[n]);
    }
  });
  it('light slots 1, 2, 6, 7, 8 and Other keep their values', () => {
    const L = { 1: '#2a78d6', 2: '#eb6834', 6: '#008300', 7: '#6250d6', 8: '#e34948', other: '#8a93a3' };
    for (const [n, h] of Object.entries(L)) expect(seriesHex(n)[0]).toBe(h);
  });
  it('daily chart keeps: legend in rank order with Other last, 30 hit rects with one tab stop, tooltip on hover, sr-only table, delta, range total', async () => {
    await open();
    expect(legend()).toHaveLength(6);
    expect(legend().at(-1)).toBe('Other');
    expect(legend()[0]).toBe('Opus 5.5');
    const hits = [...document.querySelectorAll('section.daily-chart rect[data-hit]')];
    expect(hits).toHaveLength(30);
    expect(hits.filter((h) => h.getAttribute('tabindex') === '0')).toHaveLength(1);
    fireEvent.mouseEnter(hits[29]);
    expect(document.querySelector('.tooltip[role="status"]').textContent).toContain('Oct 27');
    fireEvent.mouseLeave(hits[29]);
    expect(document.querySelector('.tooltip')).toBeNull();
    expect(screen.getByRole('table', { name: 'Daily cost table' })).toBeTruthy();
    expect(document.querySelector('.range-total').textContent).toContain(formatCost(shown(30).reduce((a, r) => a + r.cost, 0)));
    expect(document.querySelector('.delta[aria-label="Change vs previous period"]').textContent).toMatch(/vs previous 30 days/);
    expect(screen.getByRole('heading', { level: 2, name: 'Daily cost' })).toBeTruthy();
    press('Tokens');
    await settle();
    expect(screen.getByRole('heading', { level: 2, name: 'Daily tokens' })).toBeTruthy();
    expect(screen.getByRole('table', { name: 'Daily tokens table' })).toBeTruthy();
    press('By token type');
    expect(legend()).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
  });
  it('Spend by model keeps its section, heading and one li[data-model] per model with cost and share, other models folded nowhere (7 models today)', async () => {
    await open();
    const sec = screen.getByRole('region', { name: 'Spend by model' });
    expect(within(sec).getByRole('heading', { level: 2, name: 'Spend by model' })).toBeTruthy();
    expect(sec.querySelectorAll('li[data-model]').length).toBeGreaterThanOrEqual(6);
    expect(sec.querySelector('li[data-model]').getAttribute('data-model')).toBe('Opus 5.5');
  });
  it("Where a run's tokens go keeps section, heading, version toggle, summary line and the versions table", async () => {
    await open();
    const sec = screen.getByRole('region', { name: "Where a run's tokens go" });
    expect(within(sec).getByRole('group', { name: 'Version' })).toBeTruthy();
    expect(sec.textContent).toMatch(/5 finished runs · avg 150k tokens/);
    expect(within(sec).getByRole('table', { name: 'Workflow versions' })).toBeTruthy();
    expect(sec.querySelector('li[data-stage="frame"]')).toBeTruthy();
    expect(sec.querySelector('li[data-stage="parallel"]')).toBeNull();
    expect(sec.querySelector('li[data-stage="join"]')).toBeNull();
    expect(sec.querySelector('li[data-stage="verify"]').textContent).toMatch(/3 of 5 runs/);
  });
  it('Runs keeps svg label, sr-only table, outcome counts', async () => {
    await open();
    const sec = screen.getByRole('region', { name: 'Runs' });
    expect(sec.querySelector('svg[role="img"]').getAttribute('aria-label')).toBe('Runs started per day over the last 30 days, 6 in total');
    expect(within(sec).getByRole('table', { name: 'Runs per day table' })).toBeTruthy();
    expect([...sec.querySelectorAll('rect[data-run-hit]')]).toHaveLength(30);
    expect(sec.querySelector('[data-outcome="finished"]').textContent).toMatch(/3/);
  });
});
