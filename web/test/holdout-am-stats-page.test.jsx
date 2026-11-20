// Holdout (Stats page #2246): the cost-first Stats page and the shared refresh throttle. Vitest + jsdom.
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

describe('header controls and remembered choices', () => {
  it('has an h1 and Range / Metric groups; defaults to 30 days and Cost; fetches 2 x the range', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Stats' })).toBeTruthy();
    for (const n of ['7 days', '30 days', '90 days']) expect(within(screen.getByRole('group', { name: 'Range' })).getByRole('button', { name: n })).toBeTruthy();
    for (const n of ['Cost', 'Tokens']) expect(within(screen.getByRole('group', { name: 'Metric' })).getByRole('button', { name: n })).toBeTruthy();
    expect([pressed('Range', '30 days'), pressed('Range', '7 days'), pressed('Metric', 'Cost'), pressed('Metric', 'Tokens')]).toEqual(['true', 'false', 'true', 'false']);
    expect(document.querySelector('.page-head h1, header.page-head h1')).toBeTruthy();
    expect(usageCalls()[0]).toBe('/api/stats/usage?days=60');
    const cap = screen.queryAllByText(/API-equivalent/i).filter((e) => !e.closest('details.prices'));
    expect(cap.length).toBeGreaterThanOrEqual(1);
    expect(cap[0].textContent).toMatch(/estimate/i);
    expect(cap.length).toBe(1); // labelled once on the page, outside the prices
    expect(document.body.textContent).toMatch(/estimate/i);
  });

  it('range change fetches at once with 2 x days (14 / 180); a metric switch does not fetch', async () => {
    await open();
    const n0 = usageCalls().length;
    press('Tokens');
    await settle();
    expect(usageCalls().length).toBe(n0);
    press('7 days');
    await settle();
    expect(usageCalls().at(-1)).toBe('/api/stats/usage?days=14');
    press('90 days');
    await settle();
    expect(usageCalls().at(-1)).toBe('/api/stats/usage?days=180');
    expect([pressed('Range', '90 days'), pressed('Metric', 'Tokens')]).toEqual(['true', 'true']);
  });

  it('remembers both choices in localStorage under the agreed keys and restores them', async () => {
    const { unmount } = await open();
    press('Tokens'); press('7 days');
    expect(localStorage.getItem('agent-monitor-stats-metric')).toBe('tokens');
    expect(localStorage.getItem('agent-monitor-stats-range')).toBe('7');
    unmount();
    await open();
    expect([pressed('Range', '7 days'), pressed('Metric', 'Tokens')]).toEqual(['true', 'true']);
    expect(usageCalls().at(-1)).toBe('/api/stats/usage?days=14');
  });

  it('invalid stored values fall back to the defaults', async () => {
    localStorage.setItem('agent-monitor-stats-range', '15'); localStorage.setItem('agent-monitor-stats-metric', 'bananas');
    await open();
    expect([pressed('Range', '30 days'), pressed('Metric', 'Cost')]).toEqual(['true', 'true']);
  });

  it('works when storage throws on read and on write', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    await open();
    expect([pressed('Range', '30 days'), pressed('Metric', 'Cost')]).toEqual(['true', 'true']);
    press('Tokens'); press('90 days');
    expect([pressed('Range', '90 days'), pressed('Metric', 'Tokens')]).toEqual(['true', 'true']);
  });
});

describe('KPI strip', () => {
  it('four tiles; headline follows the metric, sub-line is the other metric; Codex line stays; no breakdown', async () => {
    await open();
    const t = tiles();
    expect(Object.keys(t)).toEqual(['Today', 'This week', 'This month', 'Daily average (30 d)']);
    for (const el of Object.values(t)) expect(el.getAttribute('role')).toBe('group');
    const p = periods();
    const val = (k) => t[k].querySelector('.stat-value').textContent;
    const sub = (k) => t[k].querySelector('.stat-sub').textContent;
    expect(val('Today')).toBe(formatCost(p.today.cost));
    expect(sub('Today')).toBe(`${formatTokens(p.today.total)} tokens`);
    expect(val('This month')).toBe(formatCost(p.month.cost));
    expect(val('Daily average (30 d)')).toBe(formatCost(p.avg30.cost));
    press('Tokens');
    const t2 = tiles();
    expect(t2.Today.querySelector('.stat-value').textContent).toBe(formatTokens(p.today.total));
    expect(t2.Today.querySelector('.stat-sub').textContent).toBe(`≈ ${formatCost(p.today.cost)}`);
    expect(t2['This week'].querySelector('.stat-value').textContent).toBe(formatTokens(p.week.total));
    const line = document.querySelector('.codex-line[aria-label="Codex Today"]');
    expect(line.textContent).toBe(`Codex: ${formatTokens(5_100_000)} tokens`);
    expect(document.querySelector('.codex-line[aria-label="Codex This week"]')).toBeNull(); // 0 codex tokens: no line
    for (const el of Object.values(t2)) expect(el.textContent).not.toMatch(/cache (write|read)|\binput\b|\boutput\b/i);
  });
});

describe('daily chart', () => {
  it('headline, range total and the change versus the previous period', async () => {
    await open();
    const sec = document.querySelector('section.daily-chart');
    expect(sec.querySelector('h2').textContent).toBe('Daily cost');
    expect(sec.getAttribute('aria-label')).toBe('Daily cost');
    const cur = shown(30).reduce((a, r) => a + r.cost, 0);
    const prev = ROWS.filter((r) => r.provider !== 'codex' && r.day >= dayStr(59) && r.day < dayStr(29)).reduce((a, r) => a + r.cost, 0);
    expect(sec.querySelector('.range-total').textContent).toContain(formatCost(cur));
    const pct = Math.round((Math.abs(cur - prev) / prev) * 100);
    expect(document.querySelector('.delta[aria-label="Change vs previous period"]').textContent).toBe(`${cur > prev ? '▲' : '▼'} ${pct}% vs previous 30 days`);
    press('Tokens');
    expect(document.querySelector('section.daily-chart h2').textContent).toBe('Daily tokens');
    const curT = shown(30).reduce((a, r) => a + r.total, 0);
    expect(document.querySelector('section.daily-chart .range-total').textContent).toContain(formatTokens(curT));
  });

  it('delta: no data when the data starts after the previous period began; nothing when covered but empty; no change when equal', async () => {
    usageOverride = { rows: ROWS.filter((r) => r.day >= dayStr(29)), firstDay: dayStr(10) };
    const a = await open();
    expect(document.querySelector('.delta').textContent).toBe('No data for the previous 30 days');
    a.unmount();
    usageOverride = { rows: ROWS.filter((r) => r.day >= dayStr(29)), firstDay: dayStr(100) };
    const b = await open();
    expect(document.querySelector('.delta').textContent).toBe('Nothing in the previous 30 days');
    b.unmount();
    const same = [mk(40, 'claude-opus-5', { input: 1e6 }), mk(3, 'claude-opus-5', { input: 1e6 })];
    usageOverride = { rows: same, firstDay: dayStr(59) };
    await open();
    expect(document.querySelector('.delta').textContent).toBe('No change vs previous 30 days');
  });

  it('at most 5 model series plus Other, ranked by the selected metric, with short labels and merged ids', async () => {
    await open();
    const costRank = rank(shown(30), 'cost').map(([l]) => l);
    expect(legend()).toEqual([...costRank.slice(0, 5), 'Other']);
    for (const l of legend()) expect(l).not.toMatch(/claude-|\d{8}/);
    expect(new Set([...document.querySelectorAll('rect[data-series]')].map((r) => r.getAttribute('data-series'))).size).toBe(6);
    press('Tokens');
    const tokRank = rank(shown(30), 'tokens').map(([l]) => l);
    expect(legend()).toEqual([...tokRank.slice(0, 5), 'Other']);
    expect(costRank.slice(0, 5)).not.toEqual(tokRank.slice(0, 5)); // the fixture really separates the two rankings
  });

  it('colours follow the model: a metric or split switch never repaints a model', async () => {
    await open();
    const first = Object.fromEntries(legend().filter((l) => l !== 'Other').map((l) => [l, fillOf(l)]));
    for (const v of Object.values(first)) expect(v).toBeTruthy();
    expect(new Set(Object.values(first)).size).toBe(Object.keys(first).length); // distinct while visible
    press('Tokens');
    for (const l of legend().filter((x) => x !== 'Other')) if (first[l]) expect(fillOf(l), `${l} after metric switch`).toBe(first[l]);
    press('By token type');
    expect(legend()).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
    press('By model'); press('Cost');
    for (const l of Object.keys(first)) expect(fillOf(l), `${l} after round trip`).toBe(first[l]);
    expect(fillOf('Other')).not.toBe(first[Object.keys(first)[0]]);
  });

  it('shows no Other series with 5 or fewer models', async () => {
    usageOverride = { rows: ROWS.filter((r) => ['claude-opus-5', 'claude-sonnet-4-6', 'claude-fable-5'].includes(r.model)) };
    await open();
    expect(legend()).not.toContain('Other');
    expect(legend().length).toBe(3);
  });

  it('4-5 nice gridlines with labels; the type split reads Input / Output / Cache write / Cache read', async () => {
    await open();
    const grid = document.querySelectorAll('.daily-chart svg line.grid');
    expect(grid.length).toBeGreaterThanOrEqual(4);
    expect(grid.length).toBeLessThanOrEqual(5);
    const labels = [...document.querySelectorAll('.daily-chart svg text')].map((t) => t.textContent.trim()).filter((t) => /^\$/.test(t));
    expect(labels.length).toBeGreaterThanOrEqual(4);
    expect(labels[0]).toMatch(/^\$\d/);
    press('Tokens');
    expect(document.querySelectorAll('.daily-chart svg line.grid').length).toBeGreaterThanOrEqual(4);
    press('By token type');
    expect(document.querySelectorAll('.daily-chart svg line.grid').length).toBeLessThanOrEqual(5);
    expect(document.querySelectorAll('rect[data-day]').length).toBeGreaterThan(0);
  });

  it('keyboard: one hit per shown day, a single tab stop that rovers with arrows/Home/End; tooltip with share percentages; Escape hides', async () => {
    await open();
    const hits = () => [...document.querySelectorAll('rect[data-hit]')];
    expect(hits()).toHaveLength(30);
    expect(hits().filter((h) => h.getAttribute('tabindex') === '0')).toHaveLength(1);
    const cur = hits().find((h) => h.getAttribute('tabindex') === '0');
    act(() => cur.focus());
    expect(document.activeElement).toBe(cur);
    fireEvent.keyDown(cur, { key: 'Home' });
    expect(document.activeElement).toBe(hits()[0]);
    expect(hits().filter((h) => h.getAttribute('tabindex') === '0')).toEqual([hits()[0]]);
    fireEvent.keyDown(hits()[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(hits()[1]);
    fireEvent.keyDown(hits()[1], { key: 'ArrowLeft' });
    fireEvent.keyDown(hits()[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(hits()[0]); // clamped
    fireEvent.keyDown(hits()[0], { key: 'End' });
    expect(document.activeElement).toBe(hits()[29]);
    fireEvent.keyDown(hits()[29], { key: 'Escape' });
    expect(document.querySelector('.tooltip')).toBeNull();
    const today = document.querySelector(`rect[data-hit="${dayStr(0)}"]`);
    fireEvent.mouseEnter(today);
    const tip = document.querySelector('.tooltip');
    expect(tip.getAttribute('role')).toBe('status');
    const rows = ROWS.filter((r) => r.provider !== 'codex' && r.day === dayStr(0));
    const total = rows.reduce((a, r) => a + r.cost, 0);
    expect(tip.textContent).toContain('Oct 27');
    expect(tip.textContent).toContain(formatCost(total));
    const m = byLabel(rows, (r) => r.cost);
    for (const [l, v] of m) {
      const hit = new RegExp(`${l}: ${formatCost(v).replace(/[$.]/g, '\\$&')} \\((\\d+(?:\\.\\d)?)%\\)`).exec(tip.textContent);
      expect(hit, `tooltip line for ${l}`).toBeTruthy();
      expect(Math.abs(Number(hit[1]) - (v / total) * 100)).toBeLessThanOrEqual(1);
    }
    fireEvent.mouseLeave(today);
    fireEvent.focus(hits()[3]);
    expect(document.querySelector('.tooltip')).toBeTruthy(); // focus alone shows it
    fireEvent.blur(hits()[3]);
    expect(document.querySelector('.tooltip')).toBeNull();
  });

  it('text alternatives: svg role=img label with the total and an sr-only table of days with data', async () => {
    await open();
    const img = document.querySelector('.daily-chart svg[role="img"]');
    expect(img.getAttribute('aria-label')).toMatch(/^Stacked bars of daily cost over the last 30 days, .+ in total\. The table below has the numbers\.$/);
    const table = screen.getByRole('table', { name: 'Daily cost table' });
    const days = within(table).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent);
    expect(days).toEqual([...new Set(shown(30).map((r) => r.day))].sort());
    expect(within(table).getAllByRole('columnheader').map((c) => c.textContent).at(-1)).toBe('Total');
    press('Tokens');
    expect(screen.getByRole('table', { name: 'Daily tokens table' })).toBeTruthy();
    expect(document.querySelector('.daily-chart svg[role="img"]').getAttribute('aria-label')).toMatch(/daily tokens over the last 30 days/);
  });

  it('range 7 shows 7 hit rects and compares with the previous 7 days', async () => {
    await open();
    press('7 days'); await settle();
    expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(7);
    expect(document.querySelector('.delta').textContent).toMatch(/vs previous 7 days$/);
  });
});

describe('Spend by model', () => {
  it('ranked list of every model with data in the range, with short labels, bars, share and the other metric', async () => {
    await open();
    const sec = screen.getByRole('region', { name: 'Spend by model' });
    expect(within(sec).getByRole('heading', { level: 2, name: 'Spend by model' })).toBeTruthy();
    const list = within(sec).getByRole('list', { name: 'Models ranked by cost' });
    const items = [...list.querySelectorAll('li[data-model]')];
    const exp = rank(shown(30), 'cost');
    expect(items.map((li) => li.getAttribute('data-model'))).toEqual(exp.map(([l]) => l));
    expect(exp.length).toBe(7); // more than 5: the list is not capped
    const total = exp.reduce((a, [, v]) => a + v, 0);
    exp.forEach(([l, v], i) => {
      const txt = items[i].textContent;
      expect(txt).toContain(formatCost(v));
      const share = (v / total) * 100;
      const want = share < 1 ? `${share.toFixed(1)}%` : `${Math.round(share)}%`;
      expect(txt, `${l} share`).toContain(want);
      expect(txt).toContain(formatTokens(byLabel(shown(30), (r) => r.total).get(l))); // the other metric
    });
    expect(items.some((li) => li.textContent.includes('gpt'))).toBe(false); // codex rows are not Claude spend
    const tokens = (press('Tokens'), within(screen.getByRole('region', { name: 'Spend by model' })).getByRole('list', { name: 'Models ranked by tokens' }));
    expect([...tokens.querySelectorAll('li[data-model]')].map((li) => li.getAttribute('data-model'))).toEqual(rank(shown(30), 'tokens').map(([l]) => l));
  });

  it('uses a different range: 7 days only lists models seen in the last 7 days', async () => {
    await open();
    press('7 days'); await settle();
    const li = [...document.querySelectorAll('section[aria-label="Spend by model"] li[data-model]')].map((x) => x.getAttribute('data-model'));
    expect(li.sort()).toEqual([...new Set(shown(7).map((r) => LABEL[r.model]))].sort());
  });
});

describe("Where a run's tokens go", () => {
  const sec = () => screen.getByRole('region', { name: "Where a run's tokens go" });
  it('newest version with finished runs by default, workflow order, skipped stages, version selector, summary line', async () => {
    await open();
    expect(within(sec()).getByRole('heading', { level: 2, name: "Where a run's tokens go" })).toBeTruthy();
    const group = within(sec()).getByRole('group', { name: 'Version' });
    expect([...group.querySelectorAll('button')].map((b) => b.textContent)).toEqual(['v3', 'v2', 'v1']);
    expect(within(group).getByRole('button', { name: 'v2' }).getAttribute('aria-pressed')).toBe('true');
    expect(sec().textContent).toContain(`5 finished runs · avg ${formatTokens(150_000)} tokens · ≈ ${formatCost(2.5)} · ${formatDuration(600_000)} per run`);
    const rows = [...sec().querySelectorAll('li[data-stage]')];
    expect(rows.map((r) => r.getAttribute('data-stage'))).toEqual(['frame', 'plan', 'verify']); // parallel (nothing recorded) and join (0 runs) are skipped
    expect(rows[1].textContent).toContain('Plan');
    expect(rows[1].textContent).toContain(`${formatTokens(50_000)} tokens`);
    expect(rows[1].textContent).toContain(`≈ ${formatCost(0.9)}`);
    expect(rows[1].textContent).toContain(formatDuration(120_000));
    expect(rows[1].textContent).not.toMatch(/of \d+ runs/);
    expect(rows[2].textContent).toContain('3 of 5 runs');
    expect(rows[2].textContent).toContain(formatDuration(3_600_000));
    press('Tokens'); // bars follow the metric but the numbers stay
    expect([...sec().querySelectorAll('li[data-stage]')].map((r) => r.getAttribute('data-stage'))).toEqual(['frame', 'plan', 'verify']);
  });

  it('switching version redraws; a version without finished runs says so', async () => {
    await open();
    fireEvent.click(within(sec()).getByRole('button', { name: 'v1' }));
    expect(within(sec()).getByRole('button', { name: 'v1' }).getAttribute('aria-pressed')).toBe('true');
    expect(sec().textContent).toContain('2 finished runs');
    expect([...sec().querySelectorAll('li[data-stage]')].map((r) => r.getAttribute('data-stage'))).toEqual(['frame']);
    fireEvent.click(within(sec()).getByRole('button', { name: 'v3' }));
    expect(sec().textContent).toContain('No finished runs on v3 yet.');
    expect(sec().querySelectorAll('li[data-stage]')).toHaveLength(0);
  });

  it('compact per-version table with a dash for versions without runs, and no expand buttons', async () => {
    await open();
    const t = within(sec()).getByRole('table', { name: 'Workflow versions' });
    expect([...t.querySelectorAll('th')].map((h) => h.textContent)).toEqual(['Version', 'Finished runs', 'Avg tokens', 'Avg cost', 'Avg duration']);
    const rows = [...t.querySelectorAll('tbody tr')];
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain('-'); // v3: no runs
    expect(rows[1].textContent).toContain(formatTokens(150_000));
    expect(rows[1].textContent).toContain(formatCost(2.5));
    expect(screen.queryByRole('button', { name: /Show nodes of/ })).toBeNull();
  });

  it('falls back to the newest version when none has finished runs, and handles no versions at all', async () => {
    usageOverride = { versions: [versions()[0]] };
    const a = await open();
    expect(within(sec()).queryByRole('button', { name: 'v3' }) === null || true).toBe(true); // a single version needs no selector either way
    expect(sec().textContent).toContain('No finished runs on v3 yet.');
    a.unmount();
    usageOverride = { versions: [] };
    await open();
    expect(sec().textContent).toContain('No published versions yet.');
  });
});

describe('Runs panel', () => {
  const sec = () => screen.getByRole('region', { name: 'Runs' });
  it('runs per day over the shown range, outcome counts, median duration and average fix rounds', async () => {
    await open();
    expect(within(sec()).getByRole('heading', { level: 2, name: 'Runs' })).toBeTruthy();
    const img = sec().querySelector('svg[role="img"]');
    expect(img.getAttribute('aria-label')).toBe('Runs started per day over the last 30 days, 6 in total'); // r7 started 45 days ago
    const days = [...sec().querySelectorAll('rect[data-run-day]')].map((r) => r.getAttribute('data-run-day')).sort();
    expect(days).toEqual([dayStr(0), dayStr(1), dayStr(2), dayStr(3)].sort());
    const table = within(sec()).getByRole('table', { name: 'Runs per day table' });
    expect(table).toBeTruthy();
    const out = (k) => sec().querySelector(`[data-outcome="${k}"]`).textContent;
    expect(out('finished')).toMatch(/finished/i); expect(out('finished')).toContain('3');
    expect(out('stopped')).toMatch(/stopped/i); expect(out('stopped')).toContain('1');
    expect(out('open')).toMatch(/open/i); expect(out('open')).toContain('2');
    const stat = (label) => [...sec().querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === label).map((e) => e.parentElement.textContent)[0];
    expect(stat('Median duration')).toContain(formatDuration(20 * 60000)); // 10, 20, 40 minutes
    expect(stat('Avg fix rounds')).toContain('1.0'); // rounds 0, 1, 2 over finished runs
  });

  it('dashes when no run finished; the 7-day range drops runs started earlier', async () => {
    usageOverride = { runs: [run('a', 'active', 0, 0), run('b', 'stopped', 1, 4)] };
    const a = await open();
    const stat = (label) => [...sec().querySelectorAll('*')].filter((e) => e.children.length === 0 && e.textContent.trim() === label).map((e) => e.parentElement.textContent)[0];
    expect(stat('Median duration')).toMatch(/-|–/);
    expect(stat('Avg fix rounds')).toMatch(/-|–/);
    a.unmount();
    usageOverride = null;
    await open();
    press('7 days'); await settle();
    expect(sec().querySelector('svg[role="img"]').getAttribute('aria-label')).toBe('Runs started per day over the last 7 days, 6 in total');
  });
});

describe('Prices and page order', () => {
  it('prices sit in a closed details at the bottom; the table scrolls inside .table-scroll; inputs are labelled', async () => {
    await open();
    const d = document.querySelector('details.prices');
    expect(d).toBeTruthy();
    expect(d.open).toBe(false);
    expect(d.querySelector('summary').textContent).toBe('Prices ($ per million tokens)');
    expect(d.querySelector('.table-scroll table')).toBeTruthy();
    expect(within(d).getByLabelText('claude-opus-5 Cache read')).toBeTruthy();
    expect(d.textContent).toMatch(/claude-api skill, 2026-10-06; estimates only/);
    const order = ['Usage summary', 'Daily cost', 'Spend by model', "Where a run's tokens go", 'Runs'].map((l) => document.querySelector(`[aria-label="${l}"]`));
    order.forEach((e, i) => { expect(e, `section ${i}`).toBeTruthy(); if (i) expect(order[i - 1].compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING, `order ${i}`).toBeTruthy(); });
    const idx = document.querySelector('[aria-label="Indexer status"]');
    expect(order[4].compareDocumentPosition(idx) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(idx.compareDocumentPosition(d) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(idx.textContent).toContain('Indexer: 99 messages from 2 files');
  });
});

describe('refresh throttle', () => {
  const T = ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'];
  const fakeAll = () => { vi.useRealTimers(); vi.useFakeTimers({ toFake: T }); vi.setSystemTime(NOW); };
  const tick = async (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

  it('useThrottledTick: leading edge after a quiet period, one trailing update per window, cleared on unmount', async () => {
    expect(typeof hooks.useThrottledTick).toBe('function');
    fakeAll();
    const { result, rerender, unmount } = renderHook(({ t }) => hooks.useThrottledTick(t), { initialProps: { t: 0 } });
    expect(result.current).toBe(0);
    await tick(31_000);
    rerender({ t: 1 });
    await tick(0);
    expect(result.current).toBe(1); // first change after a quiet period passes at once
    await tick(1000); rerender({ t: 2 });
    await tick(4000); rerender({ t: 3 });
    expect(result.current).toBe(1); // coalesced
    await tick(24_000);
    expect(result.current).toBe(1); // 29 s after the last update
    await tick(1500);
    expect(result.current).toBe(3); // the trailing update at last + 30 s carries the newest value
    await tick(31_000);
    rerender({ t: 4 }); await tick(0);
    expect(result.current).toBe(4);
    rerender({ t: 5 }); await tick(1000);
    rerender({ t: 6 });
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('useThrottledTick honours a custom interval', async () => {
    fakeAll();
    const { result, rerender } = renderHook(({ t }) => hooks.useThrottledTick(t, 5000), { initialProps: { t: 0 } });
    await tick(6000); rerender({ t: 1 }); await tick(0);
    expect(result.current).toBe(1);
    rerender({ t: 2 }); await tick(4000);
    expect(result.current).toBe(1);
    await tick(1500);
    expect(result.current).toBe(2);
  });

  it('Stats page: usage, versions and runs refetch at most once per 30 s on live ticks; a range change is immediate', async () => {
    fakeAll();
    const { rerender } = render(<StatsPage tick={0} />);
    await tick(1);
    const n = () => [usageCalls().length, calls(/^\/api\/stats\/versions$/).length, calls(/^\/api\/runs$/).length];
    expect(n()).toEqual([1, 1, 1]); // mount fetches at once
    await tick(31_000);
    rerender(<StatsPage tick={1} />); await tick(1);
    expect(n()).toEqual([2, 2, 2]);
    for (let t = 2; t < 12; t++) { rerender(<StatsPage tick={t} />); await tick(1000); }
    expect(usageCalls().length).toBe(2); // ten more events inside the window: nothing
    press('7 days'); await tick(1);
    expect(usageCalls().at(-1)).toBe('/api/stats/usage?days=14'); // not throttled
    await tick(25_000);
    expect(usageCalls().length).toBeGreaterThanOrEqual(3);
    expect(usageCalls().length).toBeLessThanOrEqual(4); // at most one trailing refresh
    await tick(120_000);
    const settled = usageCalls().length;
    await tick(120_000);
    expect(usageCalls().length).toBe(settled); // no timers keep firing
  });

  it('Monitor Today tiles share the throttle', async () => {
    fakeAll();
    const props = { groups: { waiting: [], active: [], finished: [] }, query: '', view: null, loadError: null, updatedAt: null, onDone: () => {} };
    const { rerender } = render(<Monitor {...props} tick={0} />);
    await tick(1);
    expect(usageCalls()).toEqual(['/api/stats/usage?days=30']);
    await tick(31_000);
    rerender(<Monitor {...props} tick={1} />); await tick(1);
    expect(usageCalls().length).toBe(2);
    for (let t = 2; t < 10; t++) { rerender(<Monitor {...props} tick={t} />); await tick(500); }
    expect(usageCalls().length).toBe(2);
    await tick(30_000);
    expect(usageCalls().length).toBe(3);
  });
});

describe('chart helpers named in the contract', () => {
  it('niceTicks gives 4-5 ticks from 0 with a 1/2/2.5/5 step that covers the max; max <= 0 behaves as 1', () => {
    for (const max of [0, -5, 0.3, 1, 7, 13, 99, 130, 4_200_000, 8_000_000_000, 1234.5]) {
      const t = chart.niceTicks(max);
      expect(t[0]).toBe(0);
      expect(t.length).toBeGreaterThanOrEqual(4);
      expect(t.length).toBeLessThanOrEqual(5);
      const s = t[1] - t[0];
      const mant = s / 10 ** Math.floor(Math.log10(s));
      expect([1, 2, 2.5, 5].some((m) => Math.abs(m - mant) < 1e-9), `step ${s} for ${max}`).toBe(true);
      expect(t.at(-1)).toBeGreaterThanOrEqual(Math.max(max, 0) - 1e-9);
      t.forEach((v, i) => expect(Math.abs(v - i * s)).toBeLessThan(1e-9 * Math.max(1, v)));
    }
  });

  it('shortModel turns ids into "Family major.minor" and leaves anything else alone', () => {
    const f = chart.shortModel;
    expect([f('claude-opus-5-5'), f('claude-haiku-4-5-20251001'), f('claude-opus-5'), f('claude-opus-5-5-20261001'), f('claude-sonnet-4-6')]).toEqual(['Opus 5.5', 'Haiku 4.5', 'Opus 5', 'Opus 5.5', 'Sonnet 4.6']);
    expect([f('gpt-5.1-codex'), f('mystery-1'), f(''), f('claude-')]).toEqual(['gpt-5.1-codex', 'mystery-1', '', 'claude-']);
  });
});
