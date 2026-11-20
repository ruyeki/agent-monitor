import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsPage } from '../src/stats/StatsPage.jsx';
import { INTRO_MS } from '../src/stats/useIntro.js';

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


let store;
let reduce;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
  store = {};
  reduce = false;
  vi.stubGlobal('localStorage', { getItem: (k) => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); } });
  vi.stubGlobal('matchMedia', (q) => ({ matches: reduce && q.includes('reduce'), media: q, addEventListener() {}, removeEventListener() {} }));
  globalThis.fetch = vi.fn((url) => {
    if (url.startsWith('/api/stats/usage')) return res(usage());
    if (url === '/api/stats/versions') return res(versions());
    if (url === '/api/runs') return res(runs());
    if (url === '/api/prices') return res(prices());
    return res({}, false, 404);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const settle = (ms = 50) => act(() => vi.advanceTimersByTimeAsync(ms));
const press = (group, name) => fireEvent.click(within(screen.getByRole('group', { name: group })).getByRole('button', { name }));
const lineGroups = () => [...document.querySelectorAll('.daily-chart svg g.intro, .runs-chart svg g.intro')];
const lines = () => [...document.querySelectorAll('path.series-line')];
const wraps = () => [...document.querySelectorAll('.donut-wrap')];
const clean = () => {
  expect(document.querySelectorAll('.intro')).toHaveLength(0);
  expect(document.querySelectorAll('mask, [mask], [data-intro]')).toHaveLength(0);
  for (const p of lines()) {
    expect(p.hasAttribute('pathLength')).toBe(false);
    expect(p.hasAttribute('style')).toBe(false); // the paths remount clean when the intro ends
  }
};

describe('stats intro', () => {
  it('draws the lines and sweeps both donuts on first mount, with staggered delays', async () => {
    render(<StatsPage />);
    await settle();
    const g = document.querySelector('.daily-chart svg g.intro');
    expect(g).toBeTruthy();
    const dl = [...g.querySelectorAll('path.series-line')];
    expect(dl.length).toBeGreaterThan(1);
    dl.forEach((p, i) => {
      expect(p.getAttribute('pathLength')).toBe('1');
      expect(p.style.animationDelay).toBe(`${i * 60}ms`);
    });
    expect(document.querySelector('.runs-chart g.intro, section[aria-label="Runs"] g.intro')).toBeTruthy();
    expect(wraps().length).toBeGreaterThanOrEqual(2);
    for (const w of wraps()) {
      expect(w.classList.contains('intro')).toBe(true);
      const m = w.querySelector('mask[data-intro]');
      expect(m).toBeTruthy();
      expect(m.querySelector('circle').getAttribute('pathLength')).toBe('1');
      expect(w.querySelector('svg > g').getAttribute('mask')).toBe(`url(#${m.id})`);
      expect(m.id).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    const ids = wraps().map((w) => w.querySelector('mask').id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('is gone after INTRO_MS: no pathLength, mask, style or class left', async () => {
    render(<StatsPage />);
    await settle();
    expect(lineGroups().length).toBeGreaterThan(0);
    await settle(INTRO_MS + 50);
    clean();
    expect(lines().length).toBeGreaterThan(0);
    expect(document.querySelectorAll('path[data-slice]').length).toBeGreaterThan(0);
  });

  it('is absent when the user prefers reduced motion', async () => {
    reduce = true;
    render(<StatsPage />);
    await settle();
    expect(lines().length).toBeGreaterThan(0);
    clean();
  });

  it('is absent where matchMedia does not exist', async () => {
    vi.stubGlobal('matchMedia', undefined);
    render(<StatsPage />);
    await settle();
    expect(lineGroups().length).toBeGreaterThan(0); // motion allowed by default
  });

  it('does not come back on a live refresh or a metric / split / range switch after the window', async () => {
    const { rerender } = render(<StatsPage tick={0} />);
    await settle();
    await settle(INTRO_MS + 100);
    clean();
    rerender(<StatsPage tick={1} />);
    await settle(31_000);
    clean();
    press('Metric', 'Tokens');
    await settle();
    clean();
    press('Split', 'By token type');
    await settle();
    clean();
    press('Range', '7 days');
    await settle(200);
    clean();
    press('Range', '90 days');
    await settle(200);
    clean();
  });

  it('does not animate a stage donut remounted by a version switch after the window', async () => {
    render(<StatsPage />);
    await settle();
    await settle(INTRO_MS + 100);
    const stage = () => document.querySelector("section[aria-label=\"Where a run's tokens go\"]");
    press('Version', 'v3'); // no finished runs: no donut
    await settle();
    expect(stage().querySelector('.donut-wrap')).toBeNull();
    press('Version', 'v4');
    await settle();
    expect(stage().querySelector('.donut-wrap')).toBeTruthy();
    clean();
  });

  it('plays again when the Stats page is mounted again', async () => {
    const first = render(<StatsPage />);
    await settle();
    await settle(INTRO_MS + 100);
    clean();
    first.unmount();
    render(<StatsPage />);
    await settle();
    expect(lineGroups().length).toBeGreaterThan(0);
    expect(wraps().every((w) => w.classList.contains('intro'))).toBe(true);
  });

  it('keeps hover and arrow keys working during the intro', async () => {
    render(<StatsPage />);
    await settle();
    const section = document.querySelector('section[aria-label="Spend by model"]');
    const sl = [...section.querySelectorAll('path[data-slice]')];
    expect(sl.length).toBeGreaterThan(1);
    fireEvent.mouseEnter(sl[1]);
    expect(sl[0].style.opacity).toBe('0.35');
    fireEvent.mouseLeave(section.querySelector('svg > g'));
    act(() => sl[0].focus());
    fireEvent.keyDown(sl[0], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(sl[1]);
  });
});
