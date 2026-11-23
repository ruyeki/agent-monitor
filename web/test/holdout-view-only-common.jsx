// Shared fixtures for the am-view-only verifier tests (copied next to web/test files on percy as holdout-view-only-common.jsx).
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';
import { sample } from './fixtures.js';

export const NOW = Date.parse('2026-11-22T12:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const KEY = 'agent-monitor-layout';
const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const tk = (total, cost) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });

export const waitingRun = (id, over = {}) => ({
  id, title: `Wait ${id}`, stage: 'gate2', stageName: 'Gate 2: accept', round: 1, maxRounds: 5, status: 'waiting', ask: 'Accept?\nBackground: ok',
  actions: [{ label: 'Accept' }, { label: 'Stop run' }], textField: true, createdAt: iso(NOW - 3_900_000), updatedAt: iso(NOW - 600_000), ...over,
});
export const activeRun = (id, over = {}) => ({
  id, title: `Busy ${id}`, stage: 'verify', stageName: 'Verify', round: 2, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'Verify' }], actions: [],
  createdAt: iso(NOW - 720_000), updatedAt: iso(NOW - 1000), ...over,
});
export const finishedRun = (id, over = {}) => ({
  id, title: `Done ${id}`, stage: 'done', stageName: 'Done', round: 1, maxRounds: 5, status: 'finished', actions: [],
  createdAt: iso(NOW - 7_200_000), updatedAt: iso(NOW - 3_600_000), ...over,
});
const detailOf = (run) => ({ run, workflow: sample(), visits: [], nodes: {}, agents: [], activity: [], tokens: { total: tk(40, 1.86) }, durationMs: 720_000 });

let runsById = {};
export function setup() {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try { localStorage.clear(); } catch { /* ignore */ }
    runsById = {};
    globalThis.fetch = vi.fn((url, opts = {}) => {
      if (opts.method === 'POST') return res({});
      const m = /^\/api\/runs\/([^/]+)$/.exec(String(url));
      if (m && runsById[decodeURIComponent(m[1])]) return res(detailOf(runsById[decodeURIComponent(m[1])]));
      if (String(url).startsWith('/api/stats/usage')) return res({ periods: { today: { total: 1000, cacheRead: 100, cost: 1.5 } } });
      return res({});
    });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); try { localStorage.clear(); } catch { /* ignore */ } });
}
const reg = (g) => { for (const r of [...g.waiting, ...g.active, ...g.finished]) runsById[r.id] = r; };
export function mount(groups, extra = {}) {
  reg(groups);
  const props = { query: '', view: null, loadError: null, updatedAt: iso(NOW), tick: 0, onDone: vi.fn(), ...extra };
  const u = render(<Monitor groups={groups} {...props} />);
  return { ...u, again: (g, e = {}) => { reg(g); u.rerender(<Monitor groups={g} {...props} {...e} />); } };
}
export const setLayout = (v) => { try { localStorage.setItem(KEY, v); } catch { /* ignore */ } };
export const inbox = () => document.querySelector('aside[aria-label="Decision inbox"]');
export const strip = () => document.querySelector('section.stat-strip[aria-label="Today"]');
export const runList = () => document.querySelector('section.run-list');
export const cardIds = () => [...document.querySelectorAll('article[data-run-id]')].filter((a) => !a.closest('aside')).map((a) => a.getAttribute('data-run-id'));
export const toggle = () => screen.queryByRole('group', { name: 'Layout' });
export const groupHeads = () => [...document.querySelectorAll('h2.group-head')].map((h) => h.textContent.replace(/\d+$/, '').trim());
export const G = () => ({ waiting: [waitingRun('w1'), waitingRun('w2')], active: [activeRun('a1'), activeRun('a2', { title: 'Other job' })], finished: [finishedRun('f1'), finishedRun('f2')] });
export { screen, within };
