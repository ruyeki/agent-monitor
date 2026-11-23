import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunSide } from '../src/run/RunSide.jsx';
import { pillLabel, toolCalls } from '../src/lib/toolCalls.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 };

let nextId = 100;
// Rows are given oldest first and returned newest first, like detail().activity.
const rows = (...list) => list.map((r) => ({ id: nextId++, agentId: 'a1', event: 'tool', tool: 'Bash', summary: 'ls', toolUseId: null, endedAt: null, outcome: null, ...r })).reverse();
const mk = (over = {}) => ({
  run: { id: 'r', title: 'R', stage: 'build', stageName: 'BUILD', round: 1, maxRounds: 5, status: 'active', actions: [], active: [{ id: 'build', name: 'BUILD' }] },
  agents: [{ id: 'a1', type: 'worker', status: 'running', lastActivityAt: iso(NOW - 5000) }],
  activity: [],
  timeline: [],
  tokens: { total: tk, main: tk, unattributed: tk, nodes: tk },
  durationMs: 1000,
  ...over,
});
const one = (activity, over = {}) => toolCalls(mk({ activity, ...over }), NOW)[0];

describe('toolCalls() status rules', () => {
  it('outcome ok is success with the duration, error is error with the error row text', () => {
    const [ok] = toolCalls(mk({ activity: rows({ at: iso(NOW - 5000), toolUseId: 'u', outcome: 'ok', endedAt: iso(NOW - 3500) }) }), NOW);
    expect(ok).toMatchObject({ tool: 'Bash', status: 'success', durationMs: 1500, error: null, agent: 'worker', agentId: 'a1' });
    const activity = rows(
      { at: iso(NOW - 5000), toolUseId: 'u', outcome: 'error', endedAt: iso(NOW - 4000) },
      { at: iso(NOW - 4000), event: 'error', summary: 'exit 2', toolUseId: 'u' },
    );
    const [err] = toolCalls(mk({ activity }), NOW);
    expect(err).toMatchObject({ status: 'error', error: 'exit 2', durationMs: 1000 });
  });
  it('an error row with no matching text gives error null; a negative duration clamps to 0', () => {
    expect(one(rows({ at: iso(NOW - 1000), outcome: 'error', endedAt: iso(NOW - 2000) }))).toMatchObject({ status: 'error', error: null, durationMs: 0 });
  });
  it('no outcome: running only for a live run with a running agent and fresh activity', () => {
    expect(one(rows({ at: iso(NOW - 5000) })).status).toBe('running');
    expect(one(rows({ at: iso(NOW - 5000) }), { run: { ...mk().run, status: 'done' } }).status).toBe('unknown');
    expect(one(rows({ at: iso(NOW - 5000) }), { run: { ...mk().run, status: 'stopped' } }).status).toBe('unknown');
    expect(one(rows({ at: iso(NOW - 5000) }), { agents: [{ id: 'a1', type: 'worker', status: 'finished' }] }).status).toBe('unknown');
    expect(one(rows({ at: iso(NOW - 5000) }), { agents: [] }).status).toBe('unknown');
  });
  it('a stop-type row from the same agent after the call makes it unknown, another agent does not', () => {
    for (const event of ['stop', 'session_end', 'subagent_stop', 'stop_failure']) {
      expect(toolCalls(mk({ activity: rows({ at: iso(NOW - 9000) }, { at: iso(NOW - 8000), event, tool: null }) }), NOW).find((c) => c.tool === 'Bash').status).toBe('unknown');
    }
    expect(toolCalls(mk({ activity: rows({ at: iso(NOW - 9000) }, { at: iso(NOW - 8000), event: 'stop', agentId: 'other' }) }), NOW).find((c) => c.tool === 'Bash').status).toBe('running');
  });
  it('the newest activity of the run must be under 30 minutes old', () => {
    expect(one(rows({ at: iso(NOW - 29 * 60_000) })).status).toBe('running');
    expect(one(rows({ at: iso(NOW - 31 * 60_000) })).status).toBe('unknown');
  });
  it('without a tool_use_id only the newest tool row of an agent can be running; with one, an open call stays running', () => {
    const noId = toolCalls(mk({ activity: rows({ at: iso(NOW - 9000), summary: 'old' }, { at: iso(NOW - 3000), summary: 'new' }) }), NOW);
    expect(noId.map((c) => [c.summary, c.status])).toEqual([['new', 'running'], ['old', 'unknown']]);
    const withId = toolCalls(mk({ activity: rows({ at: iso(NOW - 9000), summary: 'old', toolUseId: 'u1' }, { at: iso(NOW - 3000), summary: 'new', toolUseId: 'u2' }) }), NOW);
    expect(withId.map((c) => c.status)).toEqual(['running', 'running']);
  });
  it('keeps only tool rows, newest first, at most 10, and survives odd input', () => {
    const many = rows(...Array.from({ length: 14 }, (_, i) => ({ at: iso(NOW - (20 - i) * 1000), summary: `c${i}` })), { event: 'notification', tool: null, at: iso(NOW - 500) });
    const list = toolCalls(mk({ activity: many }), NOW);
    expect(list).toHaveLength(10);
    expect(list[0].summary).toBe('c13');
    expect(toolCalls(undefined, NOW)).toEqual([]);
    expect(toolCalls({}, NOW)).toEqual([]);
    expect(toolCalls(mk({ activity: [null, { event: 'tool' }] }), NOW)).toHaveLength(1);
  });
  it('agent label falls back to the agent id', () => {
    expect(one(rows({ at: iso(NOW - 1000) }), { agents: [{ id: 'a1', status: 'running' }] }).agent).toBe('a1');
  });
});

describe('pillLabel()', () => {
  const agent = { id: 'a1', type: 'worker', status: 'running', lastActivityAt: iso(NOW - 5000) };
  const label = (over, a = agent) => pillLabel(mk({ agents: [a], ...over }), a, NOW, 'BUILD');
  it('uses the running call tool name, else the stage label while recently active', () => {
    expect(label({ activity: rows({ at: iso(NOW - 3000), tool: 'Read' }) })).toBe('Read');
    const done = rows({ at: iso(NOW - 3000), outcome: 'ok', endedAt: iso(NOW - 2000) });
    expect(label({ activity: done })).toBe('BUILD');
    expect(label({ activity: done }, { ...agent, lastActivityAt: iso(NOW - 3 * 60_000) })).toBeNull();
  });
  it('no pill when waiting for permission, not running, run ended, or the newest row is a stop', () => {
    const act = rows({ at: iso(NOW - 3000) });
    expect(label({ activity: act }, { ...agent, waitingPermission: true })).toBeNull();
    expect(label({ activity: act }, { ...agent, status: 'finished' })).toBeNull();
    expect(label({ activity: act, run: { ...mk().run, status: 'done' } })).toBeNull();
    expect(label({ activity: rows({ at: iso(NOW - 3000) }, { at: iso(NOW - 2000), event: 'stop', tool: null }) })).toBeNull();
    expect(label({ activity: [] })).toBeNull();
  });
});

describe('RunSide tool calls and thinking pill', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('shows a Tool calls list with a status per card instead of Last activity', () => {
    const activity = rows(
      { at: iso(NOW - 20000), tool: 'Read', summary: '/a', toolUseId: 'u1', outcome: 'ok', endedAt: iso(NOW - 19000) },
      { at: iso(NOW - 15000), tool: 'Bash', summary: 'bad', toolUseId: 'u2', outcome: 'error', endedAt: iso(NOW - 14000) },
      { at: iso(NOW - 10000), event: 'error', tool: 'Bash', summary: 'it broke', toolUseId: 'u2' },
      { at: iso(NOW - 3000), tool: 'Edit', summary: 'f.js' },
    );
    const { container } = render(<RunSide detail={mk({ activity, agents: [{ id: 'a1', type: 'worker', status: 'finished' }] })} onChanged={() => {}} />);
    expect(screen.queryByRole('region', { name: 'Last activity' })).toBeNull();
    const section = screen.getByRole('region', { name: 'Tool calls' });
    const cards = [...section.querySelectorAll('.ui-tclc')];
    expect(cards.map((c) => c.dataset.status)).toEqual(['unknown', 'error', 'success']);
    expect(cards.map((c) => c.querySelector('code.ui-tclc__name').textContent)).toEqual(['Edit', 'Bash', 'Read']);
    expect(cards[0].querySelector('.ui-tclc__agent').textContent).toBe('worker');
    expect(within(cards[0]).getByTitle('No end recorded')).toBeTruthy();
    expect(cards[0].querySelector('.ui-tclc__spinner')).toBeNull();
    expect(cards[2].textContent).toContain('ok');
    expect(cards[1].textContent).toContain('Failed');
    expect(container.querySelector('[role="status"], [aria-live]')).toBeNull();
  });

  it('expands on click and shows the error text; an expanded row survives a refresh', () => {
    const activity = rows({ at: iso(NOW - 15000), tool: 'Bash', summary: 'bad cmd', toolUseId: 'u2', outcome: 'error', endedAt: iso(NOW - 14000) }, { at: iso(NOW - 14000), event: 'error', tool: 'Bash', summary: 'it broke', toolUseId: 'u2' });
    const { container, rerender } = render(<RunSide detail={mk({ activity })} onChanged={() => {}} />);
    const head = container.querySelector('.ui-tclc__head');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.ui-tclc__body').hasAttribute('inert')).toBe(true);
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.ui-tclc__body').hasAttribute('inert')).toBe(false);
    expect(screen.getByText('it broke')).toBeTruthy();
    rerender(<RunSide detail={mk({ activity: [...rows({ at: iso(NOW - 1000), tool: 'Read' }), ...activity] })} onChanged={() => {}} />);
    const heads = [...container.querySelectorAll('.ui-tclc__head')];
    expect(heads.map((h) => h.getAttribute('aria-expanded'))).toEqual(['false', 'true']);
  });

  it('an empty list says "No tool calls yet."', () => {
    render(<RunSide detail={mk()} onChanged={() => {}} />);
    expect(within(screen.getByRole('region', { name: 'Tool calls' })).getByText('No tool calls yet.')).toBeTruthy();
  });

  it('running call: spinner on its card and one small thinking pill in the working agent, labelled with the tool', () => {
    const { container } = render(<RunSide detail={mk({ activity: rows({ at: iso(NOW - 3000), tool: 'Grep', summary: 'x' }) })} onChanged={() => {}} />);
    expect(container.querySelector('.ui-tclc[data-status="running"] .ui-tclc__spinner')).toBeTruthy();
    const pills = container.querySelectorAll('.ui-tlc');
    expect(pills).toHaveLength(1);
    expect(pills[0].getAttribute('data-size')).toBe('sm');
    expect(pills[0].textContent).toContain('Grep');
    expect(within(screen.getByRole('region', { name: 'Active agents' })).getByText('worker')).toBeTruthy();
    expect(pills[0].hasAttribute('role')).toBe(false);
    expect(pills[0].hasAttribute('aria-live')).toBe(false);
  });

  it('no pill for an agent that is idle, waiting for permission, or when the run ended', () => {
    const idle = mk({ activity: rows({ at: iso(NOW - 600_000), outcome: 'ok', endedAt: iso(NOW - 599_000) }), agents: [{ id: 'a1', type: 'worker', status: 'running', lastActivityAt: iso(NOW - 600_000) }] });
    expect(render(<RunSide detail={idle} onChanged={() => {}} />).container.querySelector('.ui-tlc')).toBeNull();
    const perm = mk({ activity: rows({ at: iso(NOW - 3000) }), agents: [{ id: 'a1', type: 'worker', status: 'running', waitingPermission: true, lastActivityAt: iso(NOW - 3000) }] });
    expect(render(<RunSide detail={perm} onChanged={() => {}} />).container.querySelector('.ui-tlc')).toBeNull();
    const done = mk({ activity: rows({ at: iso(NOW - 3000) }), run: { ...mk().run, status: 'done' } });
    expect(render(<RunSide detail={done} onChanged={() => {}} />).container.querySelector('.ui-tlc')).toBeNull();
  });
});
