// Guards the Stats first-load animation (#2266): DOM contract of useIntro, line draw-in, donut mask sweep, reduced motion. Vitest + jsdom, fake timers.
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StatsPage } from '../src/stats/StatsPage.jsx';

const NOW = new Date(2026, 9, 27, 12, 0, 0);
const dayStr = (k) => { const d = new Date(2026, 9, 27 - k); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
const res = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost, unpriced: 0 });
const mk = (k, model, cost, total) => ({ day: dayStr(k), model, input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost, costs: { input: cost, output: 0, cacheWrite: 0, cacheRead: 0 } });
const ROWS = [];
for (const k of [0, 1, 2, 3, 5, 8, 12, 20, 40]) {
  ROWS.push(mk(k, 'claude-opus-5', 5 + k * 0.1, 1e6 + k), mk(k, 'claude-sonnet-4-6', 2 + k * 0.05, 5e5 + k), mk(k, 'claude-haiku-4-5-20251001', 0.4, 2e5 + k));
}
const VERSIONS = [
  { version: 2, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 5, avgTokens: 150000, avgCost: 2.5, avgDurationMs: 600000, nodes: [
    { id: 'frame', name: 'Frame', runs: 5, avgTokens: 10000, avgCost: 0.1, avgDurationMs: 60000 },
    { id: 'plan', name: 'Plan', runs: 5, avgTokens: 50000, avgCost: 0.9, avgDurationMs: 120000 },
    { id: 'verify', name: 'Verify', runs: 5, avgTokens: 60000, avgCost: 1.1, avgDurationMs: 300000 } ] },
  { version: 1, publishedAt: '2026-10-01T10:00:00Z', finishedRuns: 2, avgTokens: 40000, avgCost: 0.5, avgDurationMs: 90000, nodes: [
    { id: 'frame', name: 'Frame', runs: 2, avgTokens: 20000, avgCost: 0.2, avgDurationMs: 90000 },
    { id: 'plan', name: 'Plan', runs: 2, avgTokens: 15000, avgCost: 0.2, avgDurationMs: 90000 } ] },
];
const at = (k, h = 12) => new Date(2026, 9, 27 - k, h, 0, 0).toISOString();
const run = (id, status, k, durMin) => ({ id, title: id, status, round: 0, maxRounds: 5, createdAt: at(k, 9), endedAt: ['done', 'stopped'].includes(status) ? new Date(Date.parse(at(k, 9)) + durMin * 60000).toISOString() : null, updatedAt: at(k) });
const RUNS = [run('r1', 'done', 0, 10), run('r2', 'done', 1, 20), run('r3', 'done', 3, 40), run('r4', 'active', 2, 0)];

let fetchMock; let runsGate;
const body = (days) => ({
  indexer: { files: 2, messages: 99, scanning: false, lastScanAt: '2026-10-27T11:59:00Z' },
  codex: { today: tk(0), week: tk(0), month: tk(0) },
  periods: { today: tk(1e6, 5), week: tk(2e6, 9), month: tk(3e6, 40), avg30: { ...tk(9e5, 3), days: 9 } },
  daily: ROWS.filter((r) => r.day >= dayStr(days - 1)), unpricedModels: [], firstDay: dayStr(40),
});
const origMM = Object.getOwnPropertyDescriptor(window, 'matchMedia');
const setMotion = (reduce) => {
  window.matchMedia = vi.fn((q) => ({ matches: /prefers-reduced-motion:\s*reduce/.test(q) ? reduce : false, media: q, onchange: null, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {}, dispatchEvent: () => false }));
};
const noMatchMedia = () => { try { delete window.matchMedia; } catch { /* */ } if (window.matchMedia) window.matchMedia = undefined; };

beforeEach(() => {
  runsGate = null;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  fetchMock = vi.fn((url, opts = {}) => {
    const u = String(url);
    if (u.startsWith('/api/stats/usage')) return res(body(Number(/days=(\d+)/.exec(u)?.[1] ?? 90)));
    if (u === '/api/stats/versions') return res(VERSIONS);
    if (u === '/api/runs') return runsGate ? runsGate.then(() => res(RUNS)) : res(RUNS);
    if (u === '/api/prices' && opts.method === 'PUT') return res(JSON.parse(opts.body).prices);
    if (u === '/api/prices') return res([]);
    return res({}, false, 404);
  });
  globalThis.fetch = fetchMock;
  try { localStorage.clear(); } catch { /* */ }
  noMatchMedia();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (origMM) Object.defineProperty(window, 'matchMedia', origMM); else noMatchMedia();
});

const settle = async () => { await act(async () => { await vi.advanceTimersByTimeAsync(0); }); };
const wait = async (ms) => { await act(async () => { await vi.advanceTimersByTimeAsync(ms); }); };
const open = async (props = {}) => {
  const r = render(<StatsPage {...props} />);
  await settle(); await settle(); await settle(); screen.getByLabelText('Usage summary');
  await settle(); await settle();
  return r;
};
const press = (name) => fireEvent.click(screen.getByRole('button', { name }));
const daily = () => document.querySelector('section.daily-chart');
const runsSec = () => screen.getByRole('region', { name: 'Runs' });
const spendSec = () => screen.getByRole('region', { name: 'Spend by model' });
const stageSec = () => screen.getByRole('region', { name: "Where a run's tokens go" });
const linesOf = (root) => [...root.querySelectorAll('path.series-line')];
const donutWraps = () => [...document.querySelectorAll('.donut-wrap')];
const anyIntro = () => document.querySelectorAll('.intro').length;
const anyMask = () => document.querySelectorAll('mask, [mask]').length;
const anyPathLength = () => document.querySelectorAll('path.series-line[pathLength], path.series-line[pathlength]').length;
const delayMs = (el) => parseFloat(el.style.animationDelay || '0') * (/ms$/.test(el.style.animationDelay || '') ? 1 : 1000);

describe('useIntro', () => {
  it('is true on mount, false after INTRO_MS (1200), and clears its timer on unmount', async () => {
    const m = await import(/* @vite-ignore */ new URL('../src/stats/useIntro.js', import.meta.url).pathname);
    expect(m.INTRO_MS).toBe(1200);
    const { result, unmount } = renderHook(() => m.useIntro());
    expect(result.current).toBe(true);
    await wait(m.INTRO_MS - 5);
    expect(result.current).toBe(true);
    await wait(10);
    expect(result.current).toBe(false);
    await wait(5000);
    expect(result.current).toBe(false);
    const r2 = renderHook(() => m.useIntro());
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    r2.unmount();
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('is false from the start when prefers-reduced-motion: reduce matches; true when it does not match or matchMedia is missing', async () => {
    const m = await import(/* @vite-ignore */ new URL('../src/stats/useIntro.js', import.meta.url).pathname);
    setMotion(true);
    expect(renderHook(() => m.useIntro()).result.current).toBe(false);
    setMotion(false);
    expect(renderHook(() => m.useIntro()).result.current).toBe(true);
    noMatchMedia();
    expect(renderHook(() => m.useIntro()).result.current).toBe(true);
  });
});

describe('Stats intro DOM contract', () => {
  it('lines: group class intro, pathLength 1 and a 60 ms stagger in draw order, on both the daily chart and the Runs line', async () => {
    await open();
    for (const root of [daily(), runsSec()]) {
      const g = root.querySelector('path.series-line').parentElement;
      expect(g.classList.contains('intro')).toBe(true);
      const ls = linesOf(root);
      expect(ls.length).toBeGreaterThan(0);
      ls.forEach((l, i) => {
        expect(l.getAttribute('pathLength')).toBe('1');
        expect(Math.round(delayMs(l))).toBe(i * 60);
      });
      expect(g.querySelectorAll('line.guide, circle.dot').length).toBe(0);
    }
    expect(linesOf(daily()).length).toBeGreaterThanOrEqual(3);
  });

  it('donuts: wrap class intro, a data-intro mask with a clockwise-from-12 white circle, slice group masked by it, ids unique', async () => {
    await open();
    const wraps = donutWraps();
    expect(wraps.length).toBe(2);
    const ids = [];
    for (const w of wraps) {
      expect(w.classList.contains('intro')).toBe(true);
      const mask = w.querySelector('mask[data-intro]');
      expect(mask).not.toBeNull();
      ids.push(mask.id);
      expect(mask.id).toBeTruthy();
      const circle = mask.querySelector('circle');
      expect(circle.getAttribute('pathLength')).toBe('1');
      expect(circle.getAttribute('transform')).toMatch(/rotate\(\s*-90[ ,]+100[ ,]+100\s*\)/);
      expect(parseFloat(circle.getAttribute('r'))).toBeCloseTo(77, 0);
      expect(parseFloat(circle.getAttribute('stroke-width'))).toBeCloseTo(30, 0);
      const g = w.querySelector('path[data-slice]').parentElement;
      expect(g.getAttribute('mask')).toBe(`url(#${mask.id})`);
    }
    expect(new Set(ids).size).toBe(2);
  });

  it('every intro marker is gone after INTRO_MS and the final DOM is plain (no pathLength, delay, mask, class)', async () => {
    await open();
    await wait(1300);
    expect(anyIntro()).toBe(0);
    expect(anyMask()).toBe(0);
    expect(anyPathLength()).toBe(0);
    for (const l of document.querySelectorAll('path.series-line')) expect(l.style.animationDelay || '').toBe('');
    expect(document.querySelectorAll('path[data-slice]').length).toBeGreaterThan(3);
  });

  it('prefers-reduced-motion: no intro class, pathLength, mask or delay on first mount', async () => {
    setMotion(true);
    await open();
    expect(anyIntro()).toBe(0);
    expect(anyMask()).toBe(0);
    expect(anyPathLength()).toBe(0);
    expect(document.querySelectorAll('path.series-line').length).toBeGreaterThan(0);
    expect(document.querySelectorAll('path[data-slice]').length).toBeGreaterThan(3);
  });

  it('motion allowed via matchMedia (reduce does not match): intro still plays', async () => {
    setMotion(false);
    await open();
    expect(daily().querySelector('path.series-line').parentElement.classList.contains('intro')).toBe(true);
    expect(donutWraps()[0].classList.contains('intro')).toBe(true);
  });

  it('does not come back after the window: metric, split and range switches, a live tick, hover', async () => {
    const r = await open({ tick: 0 });
    await wait(1300);
    press('Tokens'); await settle();
    press('By token type'); await settle();
    press('By model'); await settle();
    press('7 days'); await settle(); await wait(50);
    press('90 days'); await settle(); await wait(50);
    expect(anyIntro()).toBe(0);
    expect(anyMask()).toBe(0);
    expect(anyPathLength()).toBe(0);
    r.rerender(<StatsPage tick={1} />);
    await settle();
    await wait(31000);
    expect(fetchMock.mock.calls.filter(([u]) => /usage/.test(String(u))).length).toBeGreaterThan(2);
    const hit = daily().querySelector('rect[data-hit]');
    fireEvent.mouseEnter(hit); fireEvent.mouseMove(hit); fireEvent.focus(hit);
    await settle();
    expect(anyIntro()).toBe(0);
    expect(anyMask()).toBe(0);
    expect(anyPathLength()).toBe(0);
  });

  it('a stage donut remounted by a version switch after the window does not animate', async () => {
    await open();
    await wait(1300);
    expect(anyMask()).toBe(0);
    press('v1'); await settle();
    const after = stageSec().querySelector('.donut-wrap');
    expect(after).not.toBeNull();
    expect(after.classList.contains('intro')).toBe(false);
    expect(after.querySelector('mask')).toBeNull();
    expect(after.querySelector('[mask]')).toBeNull();
    await wait(50);
    press('v2'); await settle();
    expect(stageSec().querySelector('.donut-wrap').classList.contains('intro')).toBe(false);
    expect(anyMask()).toBe(0);
  });

  it('a section whose data arrives later gets its own window; earlier sections are not re-animated', async () => {
    let release; runsGate = new Promise((r) => { release = r; });
    render(<StatsPage />);
    await settle(); await settle(); await settle(); screen.getByLabelText('Usage summary');
    await settle(); await settle();
    expect(screen.queryByRole('region', { name: 'Runs' })).toBeNull();
    expect(daily().querySelector('path.series-line').parentElement.classList.contains('intro')).toBe(true);
    await wait(2000);
    expect(anyIntro()).toBe(0);
    release(); await settle(); await settle();
    const g = runsSec().querySelector('path.series-line').parentElement;
    expect(g.classList.contains('intro')).toBe(true);
    expect(daily().querySelector('path.series-line').parentElement.classList.contains('intro')).toBe(false);
    expect(donutWraps().some((w) => w.classList.contains('intro'))).toBe(false);
    await wait(1300);
    expect(anyIntro()).toBe(0);
  });

  it('leaving and re-entering the page (a fresh StatsPage mount) plays the intro again', async () => {
    const r = await open();
    await wait(1500);
    expect(anyIntro()).toBe(0);
    r.unmount();
    expect(vi.getTimerCount()).toBe(0);
    await open();
    expect(daily().querySelector('path.series-line').parentElement.classList.contains('intro')).toBe(true);
    expect(donutWraps().every((w) => w.classList.contains('intro') && w.querySelector('mask[data-intro]'))).toBe(true);
  });

  it('slice dimming, legend highlight and arrow keys work while the intro runs', async () => {
    await open();
    const wrap = spendSec().querySelector('.donut-wrap');
    expect(wrap.classList.contains('intro')).toBe(true);
    const slices = [...wrap.querySelectorAll('path[data-slice]')];
    expect(slices.length).toBeGreaterThanOrEqual(3);
    const rows = [...wrap.querySelectorAll('ol.donut-legend li')];
    fireEvent.mouseEnter(rows[1]); await settle();
    expect(rows[1].classList.contains('active')).toBe(true);
    const dim = slices.map((s) => parseFloat(s.style.opacity || '1'));
    expect(dim.filter((o) => o === 0.35).length).toBe(slices.length - 1);
    fireEvent.mouseLeave(rows[1]); await settle();
    expect(slices.every((s) => parseFloat(s.style.opacity || '1') === 1)).toBe(true);
    const tabbable = slices.find((s) => s.getAttribute('tabindex') === '0');
    tabbable.focus();
    fireEvent.keyDown(tabbable, { key: 'ArrowRight' }); await settle();
    expect(slices.filter((s) => s.getAttribute('tabindex') === '0').length).toBe(1);
    expect(slices.find((s) => s.getAttribute('tabindex') === '0')).not.toBe(tabbable);
    expect(wrap.classList.contains('intro')).toBe(true);
  });

  it('hover guide and dots on the daily chart work while the intro runs and never animate', async () => {
    await open();
    expect(daily().querySelector('path.series-line').parentElement.classList.contains('intro')).toBe(true);
    const hit = daily().querySelectorAll('rect[data-hit]')[28];
    fireEvent.mouseEnter(hit); fireEvent.mouseMove(hit); await settle();
    expect(daily().querySelectorAll('line.guide').length).toBe(1);
    expect(daily().querySelectorAll('circle.dot').length).toBeGreaterThan(0);
    for (const e of daily().querySelectorAll('line.guide, circle.dot')) { expect(e.hasAttribute('pathLength')).toBe(false); expect(e.style.animationDelay || '').toBe(''); }
    expect(within(daily()).getAllByRole('status').length).toBeGreaterThan(0);
  });
});
