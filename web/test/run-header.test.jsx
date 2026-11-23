// The shared run header and tabs (contracts C4, C5), and the throttled per-run detail fetches of the Monitor (C3).
import { act, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRunDetails } from '../src/hooks.js';
import { RunView } from '../src/run/RunView.jsx';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });
const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const detail = (run = {}) => ({
  run: { id: 'r1', title: 'My run', stage: 'verify', stageName: 'Verify', round: 2, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'Verify' }], actions: [], createdAt: iso(NOW - 4_320_000), updatedAt: iso(NOW - 1000), ...run },
  workflow: sample(), timeline: [], visits: [], nodes: {}, activity: [], durationMs: 4_320_000,
  agents: [{ id: 'a1', type: 'fable-lead', status: 'running', tokens: tk(1) }, { id: 'a2', type: 'sonnet-engineer', status: 'finished', tokens: tk(1) }],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(100, 4.1) },
});

let current;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  current = detail();
  globalThis.fetch = vi.fn((url, opts = {}) => (opts.method === 'POST' ? res({}) : res(current)));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('RunHeader', () => {
  it('live run: breadcrumb to the Monitor, title, status pill, stage chip, agents, cost, run time, Stop run and the Run views tabs', async () => {
    render(<RunView id="r1" />);
    const head = (await screen.findByRole('heading', { level: 1, name: 'My run' })).closest('header');
    const crumb = within(head).getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Monitor' }).getAttribute('href')).toBe('#/');
    expect(crumb.textContent).toContain('r1');
    expect(head.querySelector('.pill').textContent).toBe('Running');
    expect(head.querySelector('.chip').textContent).toBe('Verify · round 2/5');
    expect(head.textContent).toContain('2 agents');
    expect(head.textContent).toContain('$4.10');
    expect(head.textContent).toContain('1h 12m');
    expect(within(head).getByRole('button', { name: 'Stop run' })).toBeTruthy();
    const tabs = within(head).getByRole('tablist', { name: 'Run views' });
    const tab = within(tabs).getByRole('tab', { name: 'Stages' });
    expect(tab.getAttribute('aria-selected')).toBe('true');
    expect(tab.getAttribute('href')).toBe('#/runs/r1/stages');
    expect(screen.getByRole('tabpanel', { name: 'Stages' })).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Run graph' })).toBeTruthy();
  });

  it('ended run: Done pill, no stage chip and no Stop run; a crew or ledger link still shows the Stages tab', async () => {
    current = detail({ status: 'done', stage: 'done', endedAt: iso(NOW - 60_000) });
    render(<RunView id="r1" tab="ledger" />);
    const head = (await screen.findByRole('heading', { level: 1, name: 'My run' })).closest('header');
    expect(head.querySelector('.pill').textContent).toBe('Done');
    expect(head.querySelector('.chip')).toBeNull();
    expect(within(head).queryByRole('button', { name: 'Stop run' })).toBeNull();
    expect(head.textContent).toContain('1h 11m');
    expect(within(head).getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('true');
  });
});

describe('useRunDetails (C3)', () => {
  beforeEach(() => {
    vi.useRealTimers(); // re-install: a second useFakeTimers() keeps the Date-only fake of the outer beforeEach
    vi.useFakeTimers();
  });
  const flush = () => act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const calls = () => globalThis.fetch.mock.calls.map(([u]) => u);

  it('fetches live runs at once, then at most once per 3 s however often the tick moves; ended runs once per id@updatedAt', async () => {
    const live = [{ id: 'a' }, { id: 'b' }];
    const ended = [{ id: 'd', updatedAt: 't1' }];
    const { result, rerender } = renderHook(({ tick, endedRuns }) => useRunDetails(live, endedRuns, tick), { initialProps: { tick: 0, endedRuns: ended } });
    await flush();
    expect(calls().sort()).toEqual(['/api/runs/a', '/api/runs/b', '/api/runs/d']);
    expect(result.current('a')).toEqual(current);
    for (let t = 1; t <= 20; t++) rerender({ tick: t, endedRuns: ended }); // a burst of SSE events
    await flush();
    expect(calls()).toHaveLength(3);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(calls().filter((u) => u === '/api/runs/a')).toHaveLength(2);
    expect(calls().filter((u) => u === '/api/runs/d')).toHaveLength(1); // an ended run never refetches on ticks
    rerender({ tick: 21, endedRuns: [{ id: 'd', updatedAt: 't2' }] });
    await flush();
    expect(calls().filter((u) => u === '/api/runs/d')).toHaveLength(2);
    expect(result.current('nope')).toBeNull();
  });
});

