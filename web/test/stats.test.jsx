import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCost } from '../src/lib/format.js';
import { parseRoute } from '../src/lib/route.js';
import { buildSeries, niceMax } from '../src/stats/chart.js';
import { StatsPage } from '../src/stats/StatsPage.jsx';

const res = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const tk = (input, output, cacheWrite, cacheRead, cost) => ({ input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost });
const row = (day, model, input, output, cacheWrite, cacheRead) => ({ day, model, input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost: 0 });

const usage = () => ({
  indexer: { files: 12, messages: 3400, scanning: false, lastScanAt: '2026-10-27T11:59:00Z', lastScanMs: 20, backfillMs: 900 },
  periods: {
    today: tk(1000, 2000, 3000, 4000, 1.5),
    week: tk(10_000, 20_000, 30_000, 40_000, 12.345),
    month: tk(100_000, 200_000, 300_000, 400_000, 0.004),
    avg30: { ...tk(5000, 6000, 7000, 8000, 3), days: 9 },
  },
  daily: [
    row('2026-10-27', 'claude-opus-5', 100, 200, 300, 400),
    row('2026-10-27', 'claude-sonnet-5', 10, 20, 30, 40),
    row('2026-10-20', 'claude-opus-5', 1, 2, 3, 4),
    row('2026-09-10', 'claude-opus-5', 5, 5, 5, 5), // outside 30 days, inside 90
  ],
  unpricedModels: ['claude-mystery-1'],
});
const versions = () => [
  { version: 4, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 2, avgTokens: 150_000, avgDurationMs: 600_000, nodes: [{ id: 'plan', name: 'PLAN', runs: 2, avgTokens: 50_000, avgDurationMs: 120_000 }, { id: 'verify', name: 'VERIFY', runs: 2, avgTokens: 20_000, avgDurationMs: 60_000 }] },
  { version: 3, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 0, avgTokens: 0, avgDurationMs: 0, nodes: [] },
];
const prices = () => [
  { model: 'claude-opus-5', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' },
  { model: 'claude-sonnet-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, note: '' },
];

let fetchMock;
let putResult;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0)); // local noon, whatever TZ the machine uses
  putResult = (body) => res(body.prices);
  fetchMock = vi.fn((url, opts = {}) => {
    if (url.startsWith('/api/stats/usage')) return res(usage());
    if (url === '/api/stats/versions') return res(versions());
    if (url === '/api/prices' && opts.method === 'PUT') return putResult(JSON.parse(opts.body));
    if (url === '/api/prices') return res(prices());
    return res({}, false, 404);
  });
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const legend = () => within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem').map((li) => li.textContent.trim());
const barSeries = () => [...new Set([...document.querySelectorAll('rect[data-series]')].map((r) => r.getAttribute('data-series')))];

describe('formatters and route', () => {
  it('formats cost and routes #/stats', () => {
    expect(formatCost(12.345)).toBe('$12.35');
    expect(formatCost(0)).toBe('$0.00');
    expect(formatCost(0.004)).toBe('<$0.01');
    expect(formatCost(1234.5)).toBe('$1,234.50');
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
  });

  it('buildSeries keeps model colours by name and folds extra models into Other', () => {
    const daily = Array.from({ length: 10 }, (_, i) => row('2026-10-27', `m${i}`, i + 1, 0, 0, 0));
    const { series } = buildSeries(daily, 'model', 30);
    expect(series).toHaveLength(8);
    expect(series.at(-1)).toMatchObject({ key: 'Other', slot: -1 });
    expect(series.slice(0, 7).map((s) => s.slot)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    expect(niceMax(130)).toBe(200);
    expect(niceMax(0)).toBe(1);
  });
});

describe('StatsPage', () => {
  it('shows four period cards: total as the headline, breakdown, and a labelled estimate', async () => {
    render(<StatsPage />);
    const today = await screen.findByRole('article', { name: 'Today' });
    expect(today.textContent).toContain('10k'); // 1000+2000+3000+4000
    expect(within(today).getByText('Cache write').nextSibling.textContent).toBe('3.0k');
    expect(within(today).getByText(/≈ \$1\.50 API-equivalent \(estimate\)/)).toBeTruthy();
    expect(screen.getByRole('article', { name: 'This week' }).textContent).toContain('$12.35');
    expect(screen.getByRole('article', { name: 'This month' }).textContent).toContain('<$0.01');
    expect(screen.getByRole('article', { name: /Daily average/ }).textContent).toContain('26k');
    expect(screen.getByRole('note').textContent).toContain('claude-mystery-1');
    expect(screen.getByLabelText('Indexer status').textContent).toContain('3400 messages from 12 files');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/stats/usage?days=90');
  });

  it('toggles 30/90 days (refetching) and model/type series', async () => {
    render(<StatsPage />);
    await screen.findByRole('list', { name: 'Legend' });
    expect(legend()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(barSeries().sort()).toEqual(['claude-opus-5', 'claude-sonnet-5']);
    expect(screen.getByRole('button', { name: '90 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelectorAll('[data-hit]')).toHaveLength(90);
    // the visually hidden table lists days with data only, oldest first
    expect(within(screen.getByRole('table', { name: 'Daily tokens table' })).getAllByRole('row').slice(1).map((r) => r.cells[0].textContent)).toEqual(['2026-09-10', '2026-10-20', '2026-10-27']);

    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/stats/usage?days=30')).toBe(true));
    await waitFor(() => expect(document.querySelectorAll('[data-hit]')).toHaveLength(30));
    expect(screen.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-day="2026-09-10"]')).toBeNull(); // outside the 30-day window

    fireEvent.click(screen.getByRole('button', { name: 'By token type' }));
    expect(legend()).toEqual(['Input', 'Output', 'Cache write', 'Cache read']);
    expect(barSeries().sort()).toEqual(['cacheRead', 'cacheWrite', 'input', 'output']);
    const day = document.querySelectorAll('rect[data-day="2026-10-27"]');
    expect(day).toHaveLength(4); // one segment per token type
  });

  it('describes the chart in text and shows a tooltip on hover', async () => {
    render(<StatsPage />);
    await screen.findByRole('list', { name: 'Legend' });
    expect(screen.getByRole('img').getAttribute('aria-label')).toMatch(/last 90 days, .* in total/);
    fireEvent.mouseEnter(document.querySelector('[data-hit="2026-10-27"]'));
    const tip = screen.getByRole('status', { name: '' });
    expect(tip.textContent).toContain('claude-opus-5: 1.0k');
  });

  it('expands a version into per-node rows', async () => {
    render(<StatsPage />);
    const v4 = await screen.findByRole('button', { name: 'Show nodes of v4' });
    const table = v4.closest('table');
    expect(within(table).getByText('150k')).toBeTruthy();
    expect(within(table).getByText('10m 0s')).toBeTruthy();
    expect(table.querySelectorAll('[data-node-row]')).toHaveLength(0);
    fireEvent.click(v4);
    expect(v4.getAttribute('aria-expanded')).toBe('true');
    const plan = table.querySelector('[data-node-row="plan"]');
    expect(plan.textContent).toContain('PLAN');
    expect(plan.textContent).toContain('50k');
    expect(plan.textContent).toContain('2m 0s');
    expect(table.querySelectorAll('[data-node-row]')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: 'Hide nodes of v4' }));
    expect(table.querySelectorAll('[data-node-row]')).toHaveLength(0);
    // a version with no finished runs shows dashes
    expect(screen.getByRole('button', { name: 'Show nodes of v3' }).closest('tr').textContent).toContain('-');
  });

  it('saves edited prices with PUT and shows the source note', async () => {
    render(<StatsPage />);
    const input = await screen.findByLabelText('claude-opus-5 Output');
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
    fireEvent.change(await screen.findByLabelText('claude-opus-5 Output'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain('output must be a non-negative number');
    expect(screen.queryByText('Saved.')).toBeNull();
  });

  it('refetches usage when tick changes (live refresh)', async () => {
    const { rerender } = render(<StatsPage tick={0} />);
    await screen.findByRole('list', { name: 'Legend' });
    const n = () => fetchMock.mock.calls.filter(([u]) => u.startsWith('/api/stats/usage')).length;
    expect(n()).toBe(1);
    rerender(<StatsPage tick={1} />);
    await waitFor(() => expect(n()).toBe(2));
  });
});
