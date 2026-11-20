// Guards the Stats first-load animation (#2266): baseline of the final (post-intro) Stats DOM of lines and donuts as it is today. Vitest + jsdom.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
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
    if (u === '/api/runs') return runsGate ? runsGate.then(() => RUNS) : res(RUNS);
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
const attrs = (el) => [...el.attributes].map((a) => a.name).sort();

describe('final Stats DOM (after any intro window)', () => {
  it('series lines keep exactly their plain attributes; guide and dots untouched', async () => {
    render(<StatsPage />);
    await settle(); await settle(); await settle(); screen.getByLabelText('Usage summary');
    await settle(); await settle(); await wait(1500);
    const lines = [...document.querySelectorAll('section.daily-chart path.series-line')];
    expect(lines.length).toBeGreaterThanOrEqual(3);
    for (const l of lines) {
      expect(attrs(l)).toEqual(['class', 'd', 'data-series', 'fill', 'stroke', 'stroke-linecap', 'stroke-linejoin', 'stroke-width']);
      expect(l.getAttribute('stroke-width')).toBe('2');
      expect(l.getAttribute('class')).toBe('series-line');
      expect(l.getAttribute('style') || '').not.toMatch(/animation/);
    }
    const g = lines[0].parentElement;
    expect(g.getAttribute('class') || '').toBe('');
    expect(g.getAttribute('pointer-events')).toBe('none');
    fireEvent.mouseEnter(document.querySelectorAll('section.daily-chart rect[data-hit]')[28]); await settle();
    expect(document.querySelectorAll('section.daily-chart line.guide').length).toBe(1);
    expect(document.querySelectorAll('section.daily-chart circle.dot').length).toBeGreaterThan(0);
  });

  it('donuts: slices, legend and centre as today, no defs or mask', async () => {
    render(<StatsPage />);
    await settle(); await settle(); await settle(); screen.getByLabelText('Usage summary');
    await settle(); await settle(); await wait(1500);
    const wraps = [...document.querySelectorAll('.donut-wrap')];
    expect(wraps.length).toBe(2);
    for (const w of wraps) {
      expect(w.getAttribute('class')).toBe('donut-wrap');
      expect(w.querySelector('defs, mask, [mask]')).toBeNull();
      const slices = [...w.querySelectorAll('path[data-slice]')];
      expect(slices.length).toBeGreaterThanOrEqual(3);
      expect(slices.filter((s) => s.getAttribute('tabindex') === '0').length).toBe(1);
      expect(slices.every((s) => s.getAttribute('role') === 'img' && /\(\d/.test(s.getAttribute('aria-label')))).toBe(true);
      expect(w.querySelector('svg[role="group"]')).not.toBeNull();
      expect(w.querySelectorAll('ol.donut-legend li').length).toBeGreaterThanOrEqual(slices.length);
      expect(w.querySelector('.donut-centre .donut-value').textContent.length).toBeGreaterThan(0);
    }
  });
});
