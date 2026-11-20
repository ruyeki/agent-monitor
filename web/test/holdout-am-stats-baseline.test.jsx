// Baseline (Stats page #2246): what the touched web code does today (formatters, day helpers, PriceTable); must pass before and after the change.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { formatCost, formatDuration, formatTokens } from '../src/lib/format.js';
import { parseRoute } from '../src/lib/route.js';
import { dayLabel, dayRange, localDay } from '../src/stats/chart.js';
import { PriceTable } from '../src/stats/PriceTable.jsx';
import { Monitor } from '../src/Monitor.jsx';

const res = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

describe('formatters, route, day helpers', () => {
  it('format helpers', () => {
    expect([formatTokens(999), formatTokens(1234), formatTokens(2_500_000), formatTokens(1_314_800_000)]).toEqual(['999', '1.2k', '2.5M', '1.3B']);
    expect([formatCost(12.345), formatCost(0), formatCost(0.004), formatCost(1234.5)]).toEqual(['$12.35', '$0.00', '<$0.01', '$1,234.50']);
    expect([formatDuration(65000), formatDuration(null), formatDuration(7380000)]).toEqual(['1m 5s', '-', '2h 3m']);
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
  });

  it('localDay / dayRange / dayLabel keep working across month and year ends', () => {
    expect(localDay(new Date(2026, 0, 5))).toBe('2026-01-05');
    const r = dayRange(5, new Date(2026, 2, 2, 12));
    expect(r).toEqual(['2026-02-26', '2026-02-27', '2026-02-28', '2026-03-01', '2026-03-02']);
    expect(dayRange(3, new Date(2027, 0, 1, 9))).toEqual(['2026-12-30', '2026-12-31', '2027-01-01']);
    expect(dayLabel('2026-10-27')).toBe(new Date(2026, 9, 27).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
  });
});

describe('PriceTable (kept as is, only moved into a closed details)', () => {
  const prices = () => [
    { model: 'claude-opus-5', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' },
    { model: 'claude-sonnet-5', input: 2, output: 10, cacheWrite: 2.5, cacheWrite1h: 4, cacheRead: 0.2, note: '' },
  ];
  afterEach(() => vi.restoreAllMocks());

  it('edits, saves with PUT /api/prices and shows Saved.', async () => {
    const saved = [];
    globalThis.fetch = vi.fn((url, o = {}) => { if (o.method === 'PUT') { const b = JSON.parse(o.body); saved.push(b); return res(b.prices); } return res({}); });
    const onSaved = vi.fn();
    render(<PriceTable prices={prices()} onSaved={onSaved} />);
    expect(screen.getByText(/claude-api skill, 2026-10-06; estimates only/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('claude-opus-5 Output'), { target: { value: '30' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    await screen.findByText('Saved.');
    expect(saved[0].prices[0]).toEqual({ model: 'claude-opus-5', input: 5, output: 30, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' });
    expect(onSaved).toHaveBeenCalledTimes(1);
  });

  it('shows the server message on a 400 and no Saved.', async () => {
    globalThis.fetch = vi.fn(() => res({ error: 'output must be a non-negative number' }, false, 400));
    render(<PriceTable prices={prices()} onSaved={() => {}} />);
    fireEvent.change(screen.getByLabelText('claude-opus-5 Output'), { target: { value: '-1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save prices' }));
    expect((await screen.findByRole('alert')).textContent).toContain('output must be a non-negative number');
    expect(screen.queryByText('Saved.')).toBeNull();
  });
});

describe('Monitor Today tiles', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn((url) => (String(url).startsWith('/api/stats/usage') ? res({ periods: { today: { total: 1_500_000, cost: 12.5 } } }) : res({})));
  });
  afterEach(() => vi.restoreAllMocks());

  it('mount fetches the 30-day usage once and shows tokens and cost for today', async () => {
    render(<Monitor groups={{ waiting: [], active: [], finished: [] }} query="" view={null} loadError={null} updatedAt={null} tick={0} onDone={() => {}} />);
    const strip = screen.getByRole('region', { name: 'Today' });
    await within(strip).findByText('1.5M');
    expect(within(strip).getByText('$12.50')).toBeTruthy();
    expect(within(strip).getByText('Tokens today')).toBeTruthy();
    expect(within(strip).getByText('Cost today')).toBeTruthy();
    expect(within(strip).getByText('API-equivalent (estimate)')).toBeTruthy();
    const urls = globalThis.fetch.mock.calls.map(([u]) => u).filter((u) => u.startsWith('/api/stats/usage'));
    expect(urls).toEqual(['/api/stats/usage?days=30']);
  });
});
