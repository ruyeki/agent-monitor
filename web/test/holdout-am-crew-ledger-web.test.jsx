// Holdout: Crew tab shows a selected agent's own calls from the activity endpoint; edges only for recorded parents.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/run/RunView.jsx';
import * as api from '../src/api.js';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });
const res = (body, status = 200) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
const agent = (id, type, over = {}) => ({ id, type, description: '', model: 'claude-sonnet-5-5', status: 'running', parentId: null, context: null, lastActivityAt: iso(NOW - 3000), startedAt: iso(NOW - 600_000), tokens: tk(1, 0.5), toolCalls: 3, ...over });

const helpers = Array.from({ length: 11 }, (_, i) => agent(`h${i}`, 'sonnet-engineer', { description: `Helper ${i}`, parentId: 'lead' }));
const detail = () => ({
  run: { id: 'r1', title: 'My run', stage: 'implement', stageName: 'Implement', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'implement', name: 'Implement' }], actions: [], createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 1000) },
  workflow: sample(), timeline: [], visits: [], nodes: {}, durationMs: 3_600_000,
  agents: [
    agent('main:s1', 'main', { model: 'claude-opus-5-5' }),
    agent('lead', 'fable-lead', { model: 'claude-opus-5-5', description: 'Lead', parentId: 'main:s1' }),
    ...helpers,
    agent('stray', 'sonnet-engineer', { description: 'No recorded parent', parentId: null }),
  ],
  activity: [
    { id: 900, at: iso(NOW - 1000), agentId: 'h1', event: 'tool', tool: 'Edit', summary: 'recent-h1.js', toolUseId: 'tr1', endedAt: iso(NOW - 900), outcome: 'ok' },
    { id: 899, at: iso(NOW - 2000), agentId: 'lead', event: 'tool', tool: 'Bash', summary: 'lead-cmd', toolUseId: 'tr2', endedAt: iso(NOW - 1900), outcome: 'ok' },
  ],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: { input: 1, output: 1, cacheWrite: 0, cacheRead: 0, total: 2, cost: 1 } },
});

const old = (agentId) => Array.from({ length: 12 }, (_, i) => ({ id: 100 - i, at: iso(NOW - 3_000_000 - i * 1000), agentId, event: 'tool', tool: 'Read', summary: `ancient-${agentId}-${i}.txt`, toolUseId: `old-${agentId}-${i}`, endedAt: iso(NOW - 3_000_000 - i * 1000 + 50), outcome: 'ok' }));

let calls;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  calls = [];
  globalThis.fetch = vi.fn((url) => {
    calls.push(String(url));
    const m = /\/api\/runs\/r1\/activity\?(.*)$/.exec(String(url));
    if (m) {
      const agentId = new URLSearchParams(m[1]).get('agent');
      return res(old(agentId));
    }
    return res(detail());
  });
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const card = (id) => document.querySelector(`article[data-agent-id="${id}"]`);
const rail = () => screen.getByRole('region', { name: 'Tool calls' });

describe('holdout crew web', () => {
  it('getAgentActivity exists and requests the endpoint with the encoded agent id', async () => {
    expect(typeof api.getAgentActivity).toBe('function');
    await api.getAgentActivity('r1', 'main:s1');
    const u = calls.find((c) => c.includes('/activity'));
    expect(u).toMatch(/\/api\/runs\/r1\/activity\?/);
    expect(new URLSearchParams(u.split('?')[1]).get('agent')).toBe('main:s1');
    expect(u).not.toContain('agent=main:s1'); // colon must be encoded
  });

  it('with 13+ agents: edges only for recorded parents; the stray agent has a card but no edge', async () => {
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    const edges = [...document.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge'));
    expect(edges).toContain('main:s1->lead');
    for (let i = 0; i < 11; i++) expect(edges).toContain(`lead->h${i}`);
    expect(edges.some((e) => e.endsWith('->stray'))).toBe(false);
    expect(new Set(edges).size).toBe(edges.length);
    expect(card('stray')).toBeTruthy();
    expect(document.querySelectorAll('article[data-agent-id]').length).toBe(14);
  });

  it('clicking a card fetches that agent\'s activity and the rail shows calls older than the run detail rows', async () => {
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    fireEvent.click(within(card('h4')).getByRole('button', { name: /Helper 4|sonnet/i }));
    await waitFor(() => expect(calls.some((c) => /\/activity\?/.test(c) && c.includes('agent=h4'))).toBe(true));
    await waitFor(() => expect(within(rail()).getAllByText(/ancient-h4-0\.txt/)[0]).toBeTruthy());
    expect(within(rail()).queryByText(/recent-h1\.js/)).toBeNull();
  });

  it('switching to another card shows the other agent\'s rows, not a mix', async () => {
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    fireEvent.click(within(card('h4')).getByRole('button'));
    await waitFor(() => within(rail()).getAllByText(/ancient-h4-0\.txt/)[0]);
    fireEvent.click(within(card('h5')).getByRole('button'));
    await waitFor(() => within(rail()).getAllByText(/ancient-h5-0\.txt/)[0]);
    expect(within(rail()).queryByText(/ancient-h4-/)).toBeNull();
  });

  it('clicking the selected card again clears the filter back to the run\'s recent calls', async () => {
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    const btn = within(card('h4')).getByRole('button');
    fireEvent.click(btn);
    await waitFor(() => within(rail()).getAllByText(/ancient-h4-0\.txt/)[0]);
    fireEvent.click(btn);
    await waitFor(() => expect(within(rail()).getAllByText(/recent-h1\.js/)[0]).toBeTruthy());
    expect(within(rail()).queryByText(/ancient-h4-/)).toBeNull();
  });

  it('an activity request that fails does not crash the tab', async () => {
    globalThis.fetch = vi.fn((url) => (/\/activity\?/.test(String(url)) ? res({ error: 'boom' }, 500) : res(detail())));
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    fireEvent.click(within(card('h4')).getByRole('button'));
    await new Promise((r) => setTimeout(r, 50));
    expect(card('h4')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Tool calls' })).toBeTruthy();
  });
});
