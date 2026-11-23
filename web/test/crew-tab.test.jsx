// The Crew tab (contract C7): the tree on real parentId / context data, selection, rail, tab order and links.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunList } from '../src/RunList.jsx';
import { RunView } from '../src/run/RunView.jsx';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });
const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const agent = (id, type, over = {}) => ({ id, type, description: '', model: 'claude-sonnet-5-5', status: 'running', parentId: null, context: null, lastActivityAt: iso(NOW - 3000), startedAt: iso(NOW - 600_000), tokens: tk(1, 0.5), ...over });

const detail = (over = {}) => ({
  run: { id: 'r1', title: 'My run', stage: 'implement', stageName: 'Implement', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'implement', name: 'Implement' }], actions: [], createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 1000) },
  workflow: sample(), timeline: [], visits: [], nodes: {}, durationMs: 3_600_000,
  agents: [
    agent('main:s1', 'main', { model: 'claude-opus-5-5', status: 'idle', context: { tokens: 710, window: 1000, pct: 71 } }),
    agent('lead', 'fable-lead', { model: 'claude-opus-5-5', description: 'Lead: steer the build', parentId: 'main:s1', context: { tokens: 380, window: 1000, pct: 38 } }),
    agent('e1', 'sonnet-engineer', { description: 'Restyle the Monitor', parentId: 'lead', context: { tokens: 22, window: 100, pct: 22 } }),
    agent('v1', 'sonnet-engineer', { description: 'Verifier: write tests', parentId: 'lead', context: null }),
    agent('w1', 'sonnet-engineer', { description: 'White-hat pass', parentId: 'ghost', context: { tokens: 1, window: 100, pct: 1 } }),
  ],
  activity: [
    { id: 4, at: iso(NOW - 1000), agentId: 'e1', event: 'tool', tool: 'Edit', summary: 'web/src/Monitor.jsx', toolUseId: 't4' },
    { id: 3, at: iso(NOW - 2000), agentId: 'lead', event: 'tool', tool: 'Bash', summary: 'git status', toolUseId: 't3', endedAt: iso(NOW - 1900), outcome: 'ok' },
    { id: 2, at: iso(NOW - 3000), agentId: 'v1', event: 'tool', tool: 'Grep', summary: 'WaitingCard', toolUseId: 't2', endedAt: iso(NOW - 2900), outcome: 'ok' },
  ],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: { input: 42_000, output: 61_000, cacheWrite: 310_000, cacheRead: 2_700_000, total: 3_113_000, cost: 1.86 } },
  ...over,
});

let current;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  current = detail();
  globalThis.fetch = vi.fn(() => res(current));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const card = (id) => document.querySelector(`article[data-agent-id="${id}"]`);
const callsCard = () => screen.getByRole('region', { name: 'Tool calls' });
const crewCard = () => screen.findByRole('region', { name: 'Crew' });

describe('tabs and links', () => {
  it('Crew comes first, then Stages; the bare route shows Stages and /crew shows Crew', async () => {
    const { unmount } = render(<RunView id="r1" />);
    const tabs = within(await screen.findByRole('tablist', { name: 'Run views' }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Crew', 'Stages', 'Ledger']);
    expect(tabs.getByRole('tab', { name: 'Crew' }).getAttribute('href')).toBe('#/runs/r1/crew');
    expect(tabs.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('region', { name: 'Crew' })).toBeNull();
    unmount();
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const t2 = within(screen.getByRole('tablist', { name: 'Run views' }));
    expect(t2.getByRole('tab', { name: 'Crew' }).getAttribute('aria-selected')).toBe('true');
    expect(t2.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByRole('group', { name: 'Run graph' })).toBeNull();
  });

  it('Monitor rows of live runs go to /crew; finished rows go to /ledger', () => {
    const base = { stage: 's', stageName: 'S', round: 1, maxRounds: 5, active: [] };
    render(<RunList runs={[{ ...base, id: 'live', title: 'Live', status: 'active' }, { ...base, id: 'old', title: 'Old', status: 'done' }]} />);
    expect(screen.getByRole('link', { name: /Live/ }).getAttribute('href')).toBe('#/runs/live/crew');
    expect(screen.getByRole('link', { name: /Old/ }).getAttribute('href')).toBe('#/runs/old/ledger');
  });
});

describe('Crew tab', () => {
  it('head counts agents, running and cost', async () => {
    render(<RunView id="r1" tab="crew" />);
    const crew = await crewCard();
    expect(within(crew).getByRole('heading', { name: 'Crew' })).toBeTruthy();
    expect(crew.querySelector('.cardhead').textContent).toBe('Crew5 agents · 4 running · $1.86');
  });

  it('a connector exists only for a known parent (data-edge), none for an unknown parent', async () => {
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const edges = [...document.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge')).sort();
    expect(edges).toEqual(['lead->e1', 'lead->v1', 'main:s1->lead']);
    expect(document.querySelector('[data-edge$="->w1"]')).toBeNull();
    // the unknown-parent helper still sits in the lead's children
    expect(card('lead').parentElement.querySelector('[data-agent-id="w1"]')).toBeTruthy();
  });

  it('one bar joins each group of children that has a known parent; none when no child has one; unknown-parent cards are outside it', async () => {
    const { unmount } = render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const bars = [...document.querySelectorAll('[data-bar]')];
    expect(bars).toHaveLength(2); // main's kids (the lead) and the lead's kids (e1, v1; w1 has no line)
    expect(bars.map((b) => b.parentElement.querySelectorAll(':scope > .tn-kid > [data-edge]').length).sort()).toEqual([1, 2]);
    expect(bars.every((b) => b.getAttribute('aria-hidden') === 'true')).toBe(true);
    unmount();
    current = detail({ agents: current.agents.map((a) => (a.id === 'main:s1' ? a : { ...a, parentId: null })) });
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    expect(document.querySelectorAll('[data-bar]')).toHaveLength(0);
    expect(document.querySelectorAll('[data-edge]')).toHaveLength(0);
  });

  it('the card shows role, model, status, task, current call, context bar, cost and counts', async () => {
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    expect(within(card('e1')).getByRole('button', { name: 'sonnet-engineer' })).toBeTruthy();
    expect(card('e1').textContent).toContain('Sonnet 5.5');
    expect(card('e1').textContent).toContain('Running');
    expect(card('e1').textContent).toContain('Restyle the Monitor');
    expect(card('e1').textContent).toContain('Edit web/src/Monitor.jsx');
    expect(card('e1').textContent).toContain('$0.50 · 10m');
    expect(card('e1').textContent).toContain('1 tool call');
    expect(card('lead').textContent).toContain('Opus 5.5');
    expect(card('lead').textContent).toContain('3 helpers');
    expect(within(card('v1')).getByRole('button', { name: 'verifier' })).toBeTruthy();
  });

  it('context bar: value when known, no bar at all when null (never 0%)', async () => {
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const bar = within(card('lead')).getByRole('progressbar', { name: 'Context' });
    expect(bar.getAttribute('aria-valuenow')).toBe('38');
    expect(card('lead').textContent).toContain('38%');
    expect(card('v1').querySelector('[role="progressbar"]')).toBeNull();
    expect(card('v1').textContent).not.toContain('Context');
    expect(card('v1').textContent).not.toContain('0%');
  });

  it('selecting a card (button, anywhere on the card, again to clear) filters the tool calls to that agent', async () => {
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const shown = () => callsCard().querySelectorAll('.tool-calls > *').length;
    expect(shown()).toBe(3);
    const btn = within(card('lead')).getByRole('button', { name: 'fable-lead' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(shown()).toBe(1);
    expect(callsCard().textContent).toContain('git status');
    expect(callsCard().textContent).not.toContain('Monitor.jsx');
    fireEvent.click(card('e1').querySelector('.agtask')); // a click anywhere on the card selects it too
    expect(within(card('e1')).getByRole('button', { name: 'sonnet-engineer' }).getAttribute('aria-pressed')).toBe('true');
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    expect(callsCard().textContent).toContain('Monitor.jsx');
    expect(shown()).toBe(1);
    fireEvent.click(within(callsCard()).getByRole('button', { name: /Clear filter/ }));
    expect(shown()).toBe(3);
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(shown()).toBe(3);
  });

  it('rail: Now lists running agents with their call, Totals shows tokens, cost and the four counts', async () => {
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    const now = screen.getByRole('region', { name: 'Now' });
    expect(now.textContent).toContain('sonnet-engineer');
    expect(now.textContent).toContain('Edit web/src/Monitor.jsx');
    expect(now.textContent).not.toContain('Main session'); // idle
    const tot = screen.getByRole('region', { name: 'Totals' });
    expect(tot.textContent).toContain('3.1M');
    expect(tot.textContent).toContain('$1.86');
    expect(tot.textContent).toContain('Input 42k · Output 61k · Cache write 310k · Cache read 2.7M');
  });

  it('many helpers, a second main session and a Codex agent all render', async () => {
    current = detail({
      agents: [
        agent('main:s1', 'main'), agent('main:s2', 'main'), agent('lead', 'fable-lead', { parentId: 'main:s1' }),
        ...Array.from({ length: 12 }, (_, i) => agent(`h${i}`, 'sonnet-engineer', { parentId: 'lead', description: `helper ${i}` })),
        agent('codex:t1', 'codex', { provider: 'codex', model: 'gpt-5.6-sol', parentId: 'main:s2' }),
      ],
    });
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    expect(document.querySelectorAll('article[data-agent-id]')).toHaveLength(16);
    expect(card('codex:t1').textContent).toContain('Codex');
    expect(document.querySelector('[data-edge="main:s2->codex:t1"]')).toBeTruthy();
  });

  it('empty crew: says so, keeps the rail', async () => {
    current = detail({ agents: [], activity: [] });
    render(<RunView id="r1" tab="crew" />);
    await crewCard();
    expect(screen.getByText('No agents yet.')).toBeTruthy();
    expect(screen.getByText('No agent is running.')).toBeTruthy();
    expect(screen.getByText('No tool calls yet.')).toBeTruthy();
  });
});
