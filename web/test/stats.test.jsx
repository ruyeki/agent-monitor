import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCost } from '../src/lib/format.js';
import { parseRoute } from '../src/lib/route.js';
import { StatsPage } from '../src/stats/StatsPage.jsx';

const res = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const tk = (input, output, cacheWrite, cacheRead, cost) => ({ input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost });
const row = (day, model, input, output, cacheWrite, cacheRead, cost, costs, provider = 'claude') => ({
  day, provider, model, input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost,
  costs: costs ?? { input: cost, output: 0, cacheWrite: 0, cacheRead: 0 },
});

// "now" is 27 Oct 2026, local noon. 30 days shown: 28 Sep - 27 Oct; the 30 before: 29 Aug - 27 Sep.
const usage = () => ({
  indexer: { files: 12, messages: 3400, scanning: false, lastScanAt: '2026-10-27T11:59:00Z', lastScanMs: 20, backfillMs: 900 },
  periods: {
    today: tk(1000, 2000, 3000, 4000, 1.5),
    week: tk(10_000, 20_000, 30_000, 40_000, 12.345),
    month: tk(100_000, 200_000, 300_000, 400_000, 0.004),
    avg30: { ...tk(5000, 6000, 7000, 8000, 3), days: 9 },
  },
  codex: { today: tk(1, 2, 3, 4, 0), week: tk(0, 0, 0, 0, 0), month: tk(5_000_000, 100_000, 0, 0, 0), avg30: tk(0, 0, 0, 0, 0) },
  daily: [
    row('2026-10-27', 'claude-opus-5-5', 100, 200, 300, 400, 3, { input: 0.5, output: 1, cacheWrite: 1, cacheRead: 0.5 }),
    row('2026-10-27', 'claude-sonnet-5', 10, 20, 30, 40, 0.4),
    row('2026-10-20', 'claude-opus-5-5', 1, 2, 3, 4, 0.03),
    row('2026-09-10', 'claude-opus-5-5', 5, 5, 5, 5, 0.2), // previous 30 days
    row('2026-10-27', 'gpt-5', 9_000_000, 0, 0, 0, 0, undefined, 'codex'), // never part of the Claude charts
  ],
  unpricedModels: ['claude-mystery-1'],
  firstDay: '2026-01-01',
});
const versions = () => [
  { version: 3, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0, nodes: [] },
  { version: 4, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 4, avgTokens: 150_000, avgCost: 2.5, avgDurationMs: 600_000, nodes: [
    { id: 'plan', name: 'PLAN', runs: 4, avgTokens: 50_000, avgCost: 1.25, avgDurationMs: 120_000 },
    { id: 'idle', name: 'IDLE', runs: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0 },
    { id: 'verify', name: 'VERIFY', runs: 3, avgTokens: 20_000, avgCost: 0.5, avgDurationMs: 60_000 },
    { id: 'gate', name: 'GATE', runs: 4, avgTokens: 0, avgCost: 0, avgDurationMs: 0 },
  ] },
  { version: 2, publishedAt: '2026-09-01T10:00:00Z', finishedRuns: 1, avgTokens: 9000, avgCost: 0.1, avgDurationMs: 30_000, nodes: [{ id: 'plan', name: 'PLAN', runs: 1, avgTokens: 9000, avgCost: 0.1, avgDurationMs: 30_000 }] },
];
const at = (day, hour, min = 0) => new Date(2026, 9, day, hour, min, 0).toISOString();
const runs = () => [
  { id: 'a', status: 'done', createdAt: at(27, 8), endedAt: at(27, 9), round: 1 },
  { id: 'b', status: 'done', createdAt: at(26, 8), endedAt: at(26, 11), round: 2 },
  { id: 'c', status: 'stopped', createdAt: at(26, 9), endedAt: at(26, 9, 5), round: 0 },
  { id: 'd', status: 'active', createdAt: at(25, 9), endedAt: null, round: 0 },
  { id: 'e', status: 'waiting', createdAt: at(25, 10), endedAt: null, round: 0 },
  { id: 'f', status: 'done', createdAt: new Date(2026, 5, 1).toISOString(), endedAt: new Date(2026, 5, 2).toISOString(), round: 9 }, // long ago
];
const prices = () => [
  { model: 'claude-opus-5', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' },
  { model: 'claude-sonnet-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, note: '' },
];

let fetchMock;
let putResult;
let store;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0)); // local noon, whatever TZ the machine uses
  store = {};
  vi.stubGlobal('localStorage', { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } });
  putResult = (body) => res(body.prices);
  fetchMock = vi.fn((url, opts = {}) => {
    if (url.startsWith('/api/stats/usage')) return res(usage());
    if (url === '/api/stats/versions') return res(versions());
    if (url === '/api/runs') return res(runs());
    if (url === '/api/prices' && opts.method === 'PUT') return putResult(JSON.parse(opts.body));
    if (url === '/api/prices') return res(prices());
    return res({}, false, 404);
  });
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const legend = () => within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((li) => li.textContent.trim());
const barSeries = () => [...new Set([...document.querySelectorAll('rect[data-series]')].map((r) => r.getAttribute('data-series')))];
const usageUrls = () => fetchMock.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/stats/usage'));
const tile = (name) => within(screen.getByRole('region', { name: 'Usage summary' })).getByRole('group', { name });
const press = (group, name) => fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('button', { name }));
const pressed = (group, name) => within(screen.getByRole('group', { name: group })).getByRole('button', { name }).getAttribute('aria-pressed');
const loaded = () => screen.findByRole('list', { name: 'Legend' });
const widthOf = (el) => parseFloat(el.style.width);
const styleOf = (el) => el.getAttribute('style');

describe('formatters and route', () => {
  it('formats cost and routes #/stats', () => {
    expect(formatCost(12.345)).toBe('$12.35');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1234.5)).toBe('$1,234.50');
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
  });
});

describe('header and settings', () => {
  it('defaults to 30 days and Cost, and fetches usage for twice the range', async () => {
    render(<StatsPage />);
    await loaded();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Stats');
    expect(pressed('Range', '30 days')).toBe('true');
    expect(pressed('Metric', 'Cost')).toBe('true');
    expect(usageUrls()).toEqual(['/api/stats/usage?days=60']);
    expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(30);
    expect(screen.getByRole('button', { name: '30 days' }).className).toBe('on');
    expect(screen.getByText(/API-equivalent estimates/).textContent).toMatch(/estimate/);
  });

  it('changing the range fetches at once (14 / 180) and remembers it; the metric needs no request', async () => {
    render(<StatsPage />);
    await loaded();
    press('Range', '7 days');
    await waitFor(() => expect(usageUrls()).toContain('/api/stats/usage?days=14'));
    await waitFor(() => expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(7));
    expect(store['agent-monitor-stats-range']).toBe('7');
    press('Range', '90 days');
    await waitFor(() => expect(usageUrls()).toContain('/api/stats/usage?days=180'));
    await waitFor(() => expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(90));
    expect(store['agent-monitor-stats-range']).toBe('90');
    const n = fetchMock.mock.calls.length;
    press('Metric', 'Tokens');
    expect(screen.getByRole('heading', { name: 'Daily tokens' })).toBeTruthy();
    expect(store['agent-monitor-stats-metric']).toBe('tokens');
    expect(fetchMock.mock.calls.length).toBe(n);
  });

  it('starts from remembered choices and ignores invalid ones', async () => {
    store['agent-monitor-stats-range'] = '7';
    store['agent-monitor-stats-metric'] = 'tokens';
    const first = render(<StatsPage />);
    await loaded();
    expect(pressed('Range', '7 days')).toBe('true');
    expect(pressed('Metric', 'Tokens')).toBe('true');
    expect(usageUrls()).toEqual(['/api/stats/usage?days=14']);
    first.unmount();
    store['agent-monitor-stats-range'] = '12';
    store['agent-monitor-stats-metric'] = 'bogus';
    render(<StatsPage />);
    await loaded();
    expect(pressed('Range', '30 days')).toBe('true');
    expect(pressed('Metric', 'Cost')).toBe('true');
  });

  it('works when storage throws on every access', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } });
    render(<StatsPage />);
    await loaded();
    expect(pressed('Range', '30 days')).toBe('true');
    expect(() => press('Range', '7 days')).not.toThrow();
    expect(pressed('Range', '7 days')).toBe('true');
    expect(() => press('Metric', 'Tokens')).not.toThrow();
    expect(pressed('Metric', 'Tokens')).toBe('true');
  });
});

describe('KPI strip', () => {
  it('shows cost as the figure with tokens beneath, no breakdown, and the Codex line', async () => {
    render(<StatsPage />);
    await loaded();
    const today = tile('Today');
    expect(within(today).getByText('$1.50').className).toBe('stat-value');
    expect(today.querySelector('.stat-sub').textContent).toBe('10k tokens');
    expect(today.textContent).not.toMatch(/cache write|input|output/i);
    expect(tile('This week').textContent).toContain('$12.35');
    expect(tile('This month').textContent).toContain('<$0.01');
    expect(tile('Daily average (30 d)').textContent).toContain('$3.00');
    expect(screen.getByLabelText('Codex This month').textContent).toBe('Codex: 5.1M tokens');
    expect(screen.getByLabelText('Codex Today').textContent).toBe('Codex: 10 tokens');
    expect(screen.queryByLabelText('Codex This week')).toBeNull(); // nothing from Codex that week
    expect(screen.getAllByRole('group').filter((g) => g.className === 'stat')).toHaveLength(4);
  });

  it('shows tokens as the figure with the cost beneath in Tokens mode', async () => {
    render(<StatsPage />);
    await loaded();
    press('Metric', 'Tokens');
    const today = tile('Today');
    expect(today.querySelector('.stat-value').textContent).toBe('10k');
    expect(today.querySelector('.stat-sub').textContent).toBe('≈ $1.50');
    expect(tile('Daily average (30 d)').querySelector('.stat-value').textContent).toBe('26k');
  });

  it('keeps the unpriced note and the indexer line', async () => {
    render(<StatsPage />);
    await loaded();
    expect(screen.getByRole('note').textContent).toContain('claude-mystery-1');
    expect(screen.getByLabelText('Indexer status').textContent).toContain('3400 messages from 12 files');
  });
});

describe('daily chart', () => {
  it('stacks the selected metric by model with short labels and no Codex', async () => {
    render(<StatsPage />);
    await loaded();
    expect(screen.getByRole('heading', { name: 'Daily cost' })).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Daily cost' })).toBeTruthy();
    expect(legend()).toEqual(['Opus 5.5', 'Sonnet 5']);
    expect(barSeries().sort()).toEqual(['Opus 5.5', 'Sonnet 5']);
    expect(document.querySelector('rect[data-day="2026-10-27"][data-series="gpt-5"]')).toBeNull();
    expect(document.querySelector('.range-total').textContent).toBe('$3.43 in 30 days');
    expect(screen.getByRole('img', { name: /Stacked bars of daily cost over the last 30 days, \$3\.43 in total\. The table below has the numbers\./ })).toBeTruthy();
    expect(document.querySelector('.daily-chart .grid')).toBeTruthy();
    const labels = [...document.querySelectorAll('.daily-chart svg text.axis')].map((t) => t.textContent);
    expect(labels).toContain('$0');
    // the visually hidden table lists days with data only, oldest first, inside the shown range
    const table = screen.getByRole('table', { name: 'Daily cost table' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent)).toEqual(['2026-10-20', '2026-10-27']);
    press('Metric', 'Tokens');
    expect(screen.getByRole('table', { name: 'Daily tokens table' })).toBeTruthy();
    expect(screen.getByRole('img', { name: /daily tokens over the last 30 days, 1\.1k in total/ })).toBeTruthy();
  });

  it('shows 4-5 gridlines, each with a label', async () => {
    render(<StatsPage />);
    await loaded();
    const lines = document.querySelectorAll('.daily-chart line.grid');
    expect(lines.length).toBeGreaterThanOrEqual(4);
    expect(lines.length).toBeLessThanOrEqual(5);
    expect(document.querySelectorAll('.daily-chart svg text.axis').length).toBeGreaterThanOrEqual(lines.length);
  });

  it('compares with the previous period using the selected metric', async () => {
    render(<StatsPage />);
    await loaded();
    const delta = screen.getByLabelText('Change vs previous period');
    expect(delta.textContent).toBe('▲ 1615% vs previous 30 days'); // 3.43 against 0.2
    press('Metric', 'Tokens');
    expect(screen.getByLabelText('Change vs previous period').textContent).toBe('▲ 5450% vs previous 30 days'); // 1110 against 20
  });

  it('says so when usage starts after the previous period or the period was empty', async () => {
    const u = usage();
    u.firstDay = '2026-10-10';
    fetchMock.mockImplementation((url) => (url.startsWith('/api/stats/usage') ? res(u) : url === '/api/stats/versions' ? res([]) : url === '/api/runs' ? res([]) : res(prices())));
    const first = render(<StatsPage />);
    await loaded();
    expect(screen.getByLabelText('Change vs previous period').textContent).toBe('No data for the previous 30 days');
    first.unmount();
    u.firstDay = '2026-08-29'; // exactly the first day of the previous 30 days: covered
    u.daily = u.daily.filter((r) => r.day !== '2026-09-10');
    render(<StatsPage />);
    await loaded();
    expect(screen.getByLabelText('Change vs previous period').textContent).toBe('Nothing in the previous 30 days');
  });

  it('switches the split between model and token type, in cost from the per-type costs', async () => {
    render(<StatsPage />);
    await loaded();
    press('Split', 'By token type');
    expect(legend()).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
    expect(barSeries().sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    const segs = [...document.querySelectorAll('rect[data-day="2026-10-27"]')];
    expect(segs).toHaveLength(4);
    const heights = Object.fromEntries(segs.map((r) => [r.getAttribute('data-series'), Number(r.getAttribute('height'))]));
    expect(heights.output).toBeGreaterThan(heights.input); // $1 against $0.50 + $0.40 of the sonnet row (input only): 0.9 < 1
    press('Split', 'By model');
    expect(legend()).toEqual(['Opus 5.5', 'Sonnet 5']);
  });

  it('shows a tooltip with total and per-series shares on hover, and hides it on leave', async () => {
    render(<StatsPage />);
    await loaded();
    fireEvent.mouseEnter(document.querySelector('[data-hit="2026-10-27"]'));
    const tip = screen.getByRole('status');
    expect(tip.className).toBe('tooltip');
    expect(tip.textContent).toContain('Oct 27 · $3.40');
    expect(tip.textContent).toContain('Opus 5.5: $3.00 (88%)');
    expect(tip.textContent).toContain('Sonnet 5: $0.40 (12%)');
    fireEvent.mouseLeave(document.querySelector('.chart-wrap'));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('has one tab stop that moves with the arrow keys, Home and End; Escape hides the tooltip', async () => {
    render(<StatsPage />);
    await loaded();
    const hits = () => [...document.querySelectorAll('rect[data-hit]')];
    const stops = () => hits().filter((h) => h.getAttribute('tabindex') === '0').map((h) => h.getAttribute('data-hit'));
    expect(stops()).toEqual(['2026-10-27']);
    const last = hits().at(-1);
    act(() => last.focus());
    expect(screen.getByRole('status').textContent).toContain('Oct 27');
    fireEvent.keyDown(last, { key: 'ArrowLeft' });
    expect(stops()).toEqual(['2026-10-26']);
    expect(document.activeElement.getAttribute('data-hit')).toBe('2026-10-26');
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(stops()).toEqual([hits()[0].getAttribute('data-hit')]);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowLeft' });
    expect(stops()).toEqual([hits()[0].getAttribute('data-hit')]); // stays at the start
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(stops()).toEqual(['2026-10-27']);
    fireEvent.keyDown(document.activeElement, { key: 'ArrowRight' });
    expect(stops()).toEqual(['2026-10-27']);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    act(() => hits()[3].focus());
    expect(screen.getByRole('status')).toBeTruthy();
    act(() => hits()[3].blur());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('runs chart keyboard access', () => {
  it('has one tab stop, arrow keys/Home/End move it, focus or hover shows the tooltip, Escape and blur hide it', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: 'Runs' });
    const hits = () => [...document.querySelectorAll('rect[data-run-hit]')];
    const stops = () => hits().filter((h) => h.getAttribute('tabindex') === '0').map((h) => h.getAttribute('data-run-hit'));
    expect(hits()).toHaveLength(30);
    expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(30); // the daily chart keeps its own
    expect(stops()).toEqual(['2026-10-27']);
    const last = hits().at(-1);
    act(() => last.focus());
    expect(screen.getByRole('status').textContent).toBe('Oct 27 · 1 run');
    fireEvent.keyDown(last, { key: 'ArrowLeft' });
    expect(stops()).toEqual(['2026-10-26']);
    expect(document.activeElement.getAttribute('data-run-hit')).toBe('2026-10-26');
    expect(screen.getByRole('status').textContent).toBe('Oct 26 · 2 runs');
    fireEvent.keyDown(document.activeElement, { key: 'Home' });
    expect(stops()).toEqual([hits()[0].getAttribute('data-run-hit')]);
    fireEvent.keyDown(document.activeElement, { key: 'End' });
    expect(stops()).toEqual(['2026-10-27']);
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(screen.queryByRole('status')).toBeNull();
    fireEvent.mouseEnter(hits()[hits().length - 2]);
    expect(screen.getByRole('status').textContent).toBe('Oct 26 · 2 runs');
    act(() => hits()[3].focus());
    act(() => hits()[3].blur());
    expect(screen.queryByRole('status')).toBeNull();
  });
});

describe('spend by model', () => {
  it('lists the shown range ranked by cost with value, share and the other metric', async () => {
    render(<StatsPage />);
    await loaded();
    const list = screen.getByRole('list', { name: 'Models ranked by cost' });
    const items = within(list).getAllByRole('listitem');
    expect(items.map((li) => li.getAttribute('data-model'))).toEqual(['Opus 5.5', 'Sonnet 5']);
    expect(items[0].textContent).toContain('$3.03');
    expect(items[0].textContent).toContain('88%'); // 3.03 / 3.43
    expect(items[0].textContent).toContain('1.0k tokens');
    expect(items[1].textContent).toContain('$0.40');
    expect(widthOf(items[1].querySelector('.bar-fill'))).toBeCloseTo((0.4 / 3.03) * 100, 5);
    expect(widthOf(items[0].querySelector('.bar-fill'))).toBe(100);
    expect(styleOf(items[0].querySelector('.bar-fill'))).toContain('var(--series-1)');
    expect(styleOf(items[1].querySelector('.bar-fill'))).toContain('var(--series-2)');
    // earlier than the shown range: not counted
    expect(items[0].textContent).not.toContain('$3.23');
  });

  it('re-ranks by tokens and keeps each model colour', async () => {
    render(<StatsPage />);
    await loaded();
    press('Metric', 'Tokens');
    const list = screen.getByRole('list', { name: 'Models ranked by tokens' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0].getAttribute('data-model')).toBe('Opus 5.5');
    expect(items[0].textContent).toContain('1.0k');
    expect(items[0].textContent).toContain('≈ $3.03');
    expect(styleOf(items[0].querySelector('.bar-fill'))).toContain('var(--series-1)');
  });

  it('writes under 1% with one decimal', async () => {
    const u = usage();
    u.daily = [row('2026-10-27', 'claude-opus-5-5', 1000, 0, 0, 0, 100), row('2026-10-27', 'claude-sonnet-5', 1, 0, 0, 0, 0.4)];
    fetchMock.mockImplementation((url) => (url.startsWith('/api/stats/usage') ? res(u) : url === '/api/stats/versions' ? res([]) : url === '/api/runs' ? res([]) : res(prices())));
    render(<StatsPage />);
    await loaded();
    expect(document.querySelector('[data-model="Sonnet 5"]').textContent).toContain('0.4%');
  });
});

describe("where a run's tokens go", () => {
  const panel = () => screen.getByRole('region', { name: "Where a run's tokens go" });

  it('shows the newest version with finished runs, its stages in order and a compact table', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    expect(within(panel()).getByRole('heading', { name: "Where a run's tokens go" })).toBeTruthy();
    expect(pressed('Version', 'v4')).toBe('true');
    expect(within(screen.getByRole('group', { name: 'Version' })).getAllByRole('button').map((b) => b.textContent)).toEqual(['v4', 'v3', 'v2']);
    expect(panel().querySelector('.stage-summary').textContent).toBe('4 finished runs · avg 150k tokens · ≈ $2.50 · 10m 0s per run');
    const rows = [...panel().querySelectorAll('li[data-stage]')];
    expect(rows.map((r) => r.getAttribute('data-stage'))).toEqual(['plan', 'verify']); // idle (0 runs) and gate (nothing) are skipped
    expect(rows[0].textContent).toContain('PLAN');
    expect(rows[0].querySelector('.bar-value').textContent).toBe('≈ $1.25'); // cost mode: the bold value is the bar's metric
    expect(rows[0].querySelector('.bar-share').textContent).toBe('50k tokens');
    expect(rows[0].textContent).toContain('2m 0s');
    expect(rows[0].textContent).not.toContain(' of ');
    expect(rows[1].textContent).toContain('3 of 4 runs');
    expect(widthOf(rows[0].querySelector('.bar-fill'))).toBe(100); // cost mode: 1.25 is the top
    expect(widthOf(rows[1].querySelector('.bar-fill'))).toBeCloseTo(40, 5);
    const table = within(panel()).getByRole('table', { name: 'Workflow versions' });
    expect(within(table).getAllByRole('columnheader').map((h) => h.textContent)).toEqual(['Version', 'Finished runs', 'Avg tokens', 'Avg cost', 'Avg duration']);
    const body = within(table).getAllByRole('row').slice(1);
    expect(body[0].textContent).toBe('v44150k$2.5010m 0s');
    expect(body[1].textContent).toBe('v30---');
    expect(within(panel()).queryByRole('button', { name: /nodes of/ })).toBeNull();
  });

  it('scales the bars by tokens in Tokens mode', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    press('Metric', 'Tokens');
    const rows = [...panel().querySelectorAll('li[data-stage]')];
    expect(widthOf(rows[0].querySelector('.bar-fill'))).toBe(100);
    expect(widthOf(rows[1].querySelector('.bar-fill'))).toBeCloseTo(40, 5); // 20k / 50k
    expect(rows[0].querySelector('.bar-value').textContent).toBe('50k tokens'); // tokens mode: tokens are the bold value
    expect(rows[0].querySelector('.bar-share').textContent).toBe('≈ $1.25');
  });

  it('says "1 finished run" for a single run', async () => {
    const v = [{ version: 2, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 1, avgTokens: 9000, avgCost: 0.1, avgDurationMs: 30_000, nodes: [] }];
    fetchMock.mockImplementation((url) => (url === '/api/stats/versions' ? res(v) : url.startsWith('/api/stats/usage') ? res(usage()) : url === '/api/runs' ? res([]) : res(prices())));
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    expect(panel().querySelector('.stage-summary').textContent).toMatch(/^1 finished run ·/);
  });

  it('switches version and has an empty state for a version without finished runs', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    press('Version', 'v3');
    expect(pressed('Version', 'v3')).toBe('true');
    expect(panel().textContent).toContain('No finished runs on v3 yet.');
    expect(panel().querySelectorAll('li[data-stage]')).toHaveLength(0);
    press('Version', 'v2');
    expect([...panel().querySelectorAll('li[data-stage]')].map((r) => r.getAttribute('data-stage'))).toEqual(['plan']);
  });

  it('shows the newest version when none has finished runs, and no version buttons for a single version', async () => {
    const v = [{ version: 2, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 0, avgTokens: 0, avgCost: 0, avgDurationMs: 0, nodes: [] }];
    fetchMock.mockImplementation((url) => (url === '/api/stats/versions' ? res(v) : url.startsWith('/api/stats/usage') ? res(usage()) : url === '/api/runs' ? res([]) : res(prices())));
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    expect(screen.queryByRole('group', { name: 'Version' })).toBeNull();
    expect(panel().textContent).toContain('No finished runs on v2 yet.');
  });

  it('says so when there are no published versions', async () => {
    fetchMock.mockImplementation((url) => (url === '/api/stats/versions' ? res([]) : url.startsWith('/api/stats/usage') ? res(usage()) : url === '/api/runs' ? res([]) : res(prices())));
    render(<StatsPage />);
    await screen.findByRole('region', { name: "Where a run's tokens go" });
    expect(panel().textContent).toContain('No published versions yet.');
  });
});

describe('runs', () => {
  const panel = () => screen.getByRole('region', { name: 'Runs' });

  it('counts the runs started in the shown range and how they ended', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: 'Runs' });
    expect(within(panel()).getByRole('heading', { name: 'Runs' })).toBeTruthy();
    const count = (k) => panel().querySelector(`[data-outcome="${k}"]`).textContent;
    expect(count('finished')).toContain('Finished');
    expect(count('finished')).toContain('2');
    expect(count('stopped')).toContain('Stopped');
    expect(count('stopped')).toContain('1');
    expect(count('open')).toContain('Open');
    expect(count('open')).toContain('2');
    expect(panel().textContent).toContain('Median duration');
    expect(panel().textContent).toContain('2h 0m'); // 1 h and 3 h
    expect(panel().textContent).toContain('Avg fix rounds');
    expect(panel().textContent).toContain('1.5'); // (1 + 2) / 2; the run from June is outside the range
    expect(screen.getByRole('img', { name: 'Runs started per day over the last 30 days, 5 in total' })).toBeTruthy();
    expect([...document.querySelectorAll('rect[data-run-day]')].map((r) => r.getAttribute('data-run-day'))).toEqual(['2026-10-25', '2026-10-26', '2026-10-27']);
    expect(document.querySelector('rect[data-run-hit="2026-10-26"]').getAttribute('aria-label')).toBe('Oct 26 · 2 runs');
    const table = screen.getByRole('table', { name: 'Runs per day table' });
    expect(within(table).getAllByRole('row').slice(1).map((r) => r.textContent)).toEqual(['2026-10-252', '2026-10-262', '2026-10-271']);
  });

  it('follows the range', async () => {
    render(<StatsPage />);
    await screen.findByRole('region', { name: 'Runs' });
    press('Range', '7 days');
    await waitFor(() => expect(document.querySelectorAll('rect[data-hit]')).toHaveLength(7));
    expect(screen.getByRole('img', { name: 'Runs started per day over the last 7 days, 5 in total' })).toBeTruthy();
  });

  it('shows dashes when no run finished', async () => {
    fetchMock.mockImplementation((url) => (url === '/api/runs' ? res([{ id: 'x', status: 'active', createdAt: at(27, 8), endedAt: null, round: 0 }]) : url === '/api/stats/versions' ? res([]) : url.startsWith('/api/stats/usage') ? res(usage()) : res(prices())));
    render(<StatsPage />);
    await screen.findByRole('region', { name: 'Runs' });
    const figures = [...panel().querySelectorAll('.figure-value')].map((f) => f.textContent);
    expect(figures).toEqual(['-', '-']);
    expect(panel().querySelector('[data-outcome="finished"]').textContent).toContain('0');
  });
});

describe('prices', () => {
  const open = async () => {
    const details = await waitFor(() => {
      const d = document.querySelector('details.prices');
      if (!d) throw new Error('no prices yet');
      return d;
    });
    fireEvent.click(details.querySelector('summary'));
    details.open = true;
    return details;
  };

  it('are folded away by default under a summary', async () => {
    render(<StatsPage />);
    await waitFor(() => expect(document.querySelector('details.prices')).toBeTruthy());
    const details = document.querySelector('details.prices');
    expect(details.open).toBe(false);
    expect(details.querySelector('summary').textContent).toBe('Prices ($ per million tokens)');
    expect(details.querySelector('.table-scroll table')).toBeTruthy();
    expect(details.querySelector('td.model-id')).toBeTruthy();
  });

  it('saves edited prices with PUT and shows the source note', async () => {
    render(<StatsPage />);
    await open();
    const input = screen.getByLabelText('claude-opus-5 Output');
    expect(screen.getByText(/claude-api skill, 2026-10-06; estimates only/)).toBeTruthy();
    fireEvent.change(input, { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await screen.findByText('Saved.');
    const put = fetchMock.mock.calls.find(([, o]) => o?.method === 'PUT');
    expect(put[0]).toBe('/api/prices');
    const body = JSON.parse(put[1].body);
    expect(body.prices).toHaveLength(2);
    expect(body.prices[0]).toEqual({ model: 'claude-opus-5', input: 5, output: 30, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' });
  });

  it('shows the server message when the price update is rejected with 400', async () => {
    putResult = () => res({ error: 'output must be a non-negative number' }, false, 400);
    render(<StatsPage />);
    await open();
    fireEvent.change(screen.getByLabelText('claude-opus-5 Output'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('output must be a non-negative number');
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});

describe('live refresh', () => {
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const adv = (ms) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
  const counts = () => ({ usage: usageUrls().length, versions: fetchMock.mock.calls.filter(([u]) => u === '/api/stats/versions').length, runs: fetchMock.mock.calls.filter(([u]) => u === '/api/runs').length });

  it('does not refetch when the first live event lands just after the load, then refreshes once at mount + 30 s', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
    const { rerender } = render(<StatsPage tick={0} />);
    await flush();
    expect(counts()).toEqual({ usage: 1, versions: 1, runs: 1 }); // mount fetches immediately
    await adv(250);
    rerender(<StatsPage tick={1} />); // SSE onopen
    await flush();
    expect(counts()).toEqual({ usage: 1, versions: 1, runs: 1 }); // inside the first period: held back
    for (let t = 2; t <= 6; t++) {
      await adv(2000);
      rerender(<StatsPage tick={t} />);
    }
    await flush();
    expect(counts().usage).toBe(1);
    await adv(30_000);
    expect(counts()).toEqual({ usage: 2, versions: 2, runs: 2 }); // one trailing refresh for the whole burst
    await adv(60_000);
    expect(counts().usage).toBe(2);
    rerender(<StatsPage tick={7} />); // after a quiet period the next change passes at once
    await flush();
    expect(counts()).toEqual({ usage: 3, versions: 3, runs: 3 });
  });

  it('refetches usage and versions at once after prices are saved', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
    render(<StatsPage tick={0} />);
    await flush();
    fireEvent.change(screen.getByLabelText('claude-opus-5 Output'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await flush();
    expect(counts()).toEqual({ usage: 2, versions: 2, runs: 1 }); // costs only; runs do not depend on prices
  });

  it('does not refetch prices on live ticks', async () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    const { rerender } = render(<StatsPage tick={0} />);
    await flush();
    rerender(<StatsPage tick={1} />);
    await flush();
    expect(fetchMock.mock.calls.filter(([u]) => u === '/api/prices')).toHaveLength(1);
  });
});
