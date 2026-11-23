// Shared helpers for the #2289 holdouts. Not a test file (no .test in the name).
import { render } from '@testing-library/react';
import { vi } from 'vitest';
import { createElement } from 'react';
import App from '../src/App.jsx';
import { sample } from './fixtures.js';

export const NOW = Date.parse('2026-11-22T12:00:00Z');
export const iso = (ms) => new Date(ms).toISOString();
export const tk = (input = 0, output = 0, cacheWrite = 0, cacheRead = 0, cost = 0) => ({ input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost });

export const waitingRun = (id, title, ageMin = 5, over = {}) => ({
  id, title, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting',
  ask: `Question for ${title}?\nOption: pick one`, actions: [{ label: 'Agree spec' }, { label: 'Revise' }, { label: 'Stop run' }], textField: true,
  updatedAt: iso(NOW - ageMin * 60000), ...over,
});
export const activeRun = (id, title, over = {}) => ({
  id, title, stage: 'plan', stageName: 'Plan', round: 2, maxRounds: 5, status: 'active', active: [{ id: 'plan', name: 'Plan' }], actions: [], updatedAt: iso(NOW - 2000), ...over,
});
export const doneRun = (id, title, over = {}) => ({
  id, title, stage: 'done', stageName: 'Done', round: 2, maxRounds: 5, status: 'done', actions: [], updatedAt: iso(NOW - 3600_000), ...over,
});

export const detailFor = (run, over = {}) => ({
  run: { ask: null, actions: [], textField: false, active: [{ id: run.stage, name: run.stageName }], ...run },
  workflow: sample(),
  timeline: [{ at: iso(NOW - 5000), kind: 'stage', stage: 'plan', round: 0, note: 'hello' }],
  agents: [
    { id: 'main:s1', type: 'main', description: null, model: 'claude-opus-5-5', status: 'running', lastTool: 'Bash', lastSummary: 'pwd', lastActivityAt: iso(NOW - 3000), tokens: tk(10, 5, 0, 100, 0.5), parentId: null, context: { tokens: 100000, window: 1000000, pct: 10 } },
  ],
  activity: [{ id: 1, at: iso(NOW - 1000), agentId: 'main:s1', event: 'tool', tool: 'Bash', summary: 'pwd', toolUseId: null, endedAt: null, outcome: null }],
  visits: [], nodes: {}, durationMs: 65_000,
  tokens: { nodes: tk(), main: tk(10, 5, 0, 100, 0.5), unattributed: tk(), total: tk(10, 5, 0, 100, 0.5) },
  ...over,
});

export class FakeEventSource {
  constructor() { this.readyState = 1; }
  close() { this.readyState = 2; }
}

// Installs fetch + EventSource. routes: { runs, details: {id: detail}, ledgers: {id: ledger}, respond: (id, body) => response }
export function installApi(routes = {}) {
  const calls = [];
  globalThis.EventSource = FakeEventSource;
  const ok = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    calls.push({ url: u, method, body: opts.body ? JSON.parse(opts.body) : undefined });
    let m;
    if (method === 'GET' && u === '/api/runs') return ok(routes.runs ?? []);
    if (method === 'POST' && (m = /^\/api\/runs\/([^/]+)\/respond$/.exec(u))) {
      const r = routes.respond ? routes.respond(decodeURIComponent(m[1]), JSON.parse(opts.body)) : {};
      return r && typeof r.then === 'function' ? r : ok(r);
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/]+)\/ledger$/.exec(u))) {
      const l = routes.ledgers?.[decodeURIComponent(m[1])];
      return l ? ok(l) : ok({ error: 'no ledger' }, 404);
    }
    if (method === 'GET' && (m = /^\/api\/runs\/([^/?]+)$/.exec(u))) {
      const d = routes.details?.[decodeURIComponent(m[1])];
      return d ? ok(typeof d === 'function' ? d() : d) : ok({ error: 'No such run.' }, 404);
    }
    if (u.startsWith('/api/stats/usage')) return ok({ periods: { today: { total: 123456, cost: 4.5, cacheRead: 100000, input: 1, output: 1, cacheWrite: 0 } }, daily: [], models: [] });
    return ok({});
  });
  return calls;
}

export function mountApp(hash = '#/') {
  window.location.hash = hash;
  return render(createElement(App));
}

export const clearStorage = () => { try { localStorage.clear(); } catch { /* */ } };
