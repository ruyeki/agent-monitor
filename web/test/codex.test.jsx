import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunsTable } from '../src/RunsTable.jsx';
import { RunView } from '../src/run/RunView.jsx';
import { PeriodCards } from '../src/stats/PeriodCards.jsx';
import { WaitingCard } from '../src/WaitingCards.jsx';
import { sample } from './fixtures.js';

const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const tk = (total, cost = 0, unpriced = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost, unpriced });
const claudeRun = { id: 'r1', title: 'R one', stage: 'verify', stageName: 'VERIFY', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'VERIFY' }], actions: [] };

const detail = (run, over = {}) => ({
  run: { ...claudeRun, ...run },
  workflow: sample(),
  timeline: [],
  agents: [],
  activity: [],
  visits: [],
  nodes: { plan: { visits: 1 }, verify: { visits: 1 } },
  durationMs: 1000,
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(100, 1.5) },
  ...over,
});

let current;
beforeEach(() => {
  current = detail({});
  globalThis.fetch = vi.fn(() => res(current));
});
afterEach(() => vi.restoreAllMocks());

describe('Codex runs in the run view', () => {
  it('shows nothing Codex-related for a Claude run (older servers send no provider)', async () => {
    render(<RunView id="r1" />);
    await screen.findByRole('region', { name: 'Totals' });
    expect(screen.queryByRole('region', { name: 'Codex' })).toBeNull();
    expect(screen.queryByText('Codex')).toBeNull();
  });

  it('shows the badge, the limit time, Codex tokens apart from Claude and no $ without a price', async () => {
    current = detail(
      { provider: 'codex', limitAt: '2026-11-02T10:00:00Z', resetsAt: '2026-11-02T15:00:00Z' },
      { tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(100, 1.5), codex: tk(12_345) }, visits: [{ node: 'verify', provider: 'codex' }, { node: 'plan', provider: 'claude' }] },
    );
    render(<RunView id="r1" />);
    const side = within(await screen.findByRole('region', { name: 'Codex' }));
    expect(side.getByText(/Claude usage ran out/).textContent).toMatch(/resets/);
    expect(side.getByText('12k')).toBeTruthy();
    expect(side.queryByText(/≈/)).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Run r1' })).getAllByText('Codex').length).toBeGreaterThan(0);
    await waitFor(() => expect(document.querySelector('[data-node="verify"]')).toBeTruthy());
    expect(document.querySelector('[data-node="verify"]').textContent).toContain('Codex');
    expect(document.querySelector('[data-node="plan"]').textContent).not.toContain('Codex');
  });

  it('shows a dollar estimate only when a price row gave a cost', async () => {
    current = detail({ provider: 'codex' }, { tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(1), codex: tk(500, 0.25) } });
    render(<RunView id="r1" />);
    const side = within(await screen.findByRole('region', { name: 'Codex' }));
    expect(side.getByText(/≈ \$0\.25/)).toBeTruthy();
  });
});

describe('Codex tags and stats', () => {
  it('tags Codex runs in the table and the waiting card', () => {
    render(<RunsTable runs={[{ ...claudeRun, provider: 'codex' }, { ...claudeRun, id: 'r2', title: 'R two' }]} onSelect={() => {}} caption="c" />);
    const rows = screen.getAllByRole('row').slice(1);
    expect(within(rows[0]).getByText('Codex')).toBeTruthy();
    expect(within(rows[1]).queryByText('Codex')).toBeNull();
    render(<WaitingCard run={{ ...claudeRun, status: 'waiting', ask: 'ok?', provider: 'codex' }} />);
    expect(within(screen.getByRole('article', { name: /Waiting on you/ })).getByText('Codex')).toBeTruthy();
  });

  it('period cards add a separate Codex line and leave the Claude headline alone', () => {
    const periods = { today: tk(1000, 2), week: tk(0), month: tk(0), avg30: tk(0) };
    render(<PeriodCards periods={periods} codex={{ today: tk(5000), week: tk(0), month: tk(0) }} />);
    const today = screen.getByRole('article', { name: 'Today' });
    expect(today.querySelector('.big').textContent).toBe('1.0k');
    expect(within(today).getByLabelText('Codex Today').textContent).toBe('Codex: 5.0k tokens');
    expect(screen.queryByLabelText('Codex Daily average (last 30 days with data)')).toBeNull();
  });

  it('shows no Codex line when the server has none', () => {
    render(<PeriodCards periods={{ today: tk(1) }} />);
    expect(screen.queryByText(/Codex:/)).toBeNull();
  });
});
