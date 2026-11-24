// Holdout (#2288): the Tool calls list (toolCalls model + RunSide) and the Thinking pill. Vitest + jsdom.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toolCalls } from '../src/lib/toolCalls.js';
import { RunSide } from '../src/run/RunSide.jsx';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = (n = 0) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0, total: n, cost: 0 });

let rid = 0;
const row = (agentId, tool, agoMs, over = {}) => ({ id: ++rid, at: iso(NOW - agoMs), agentId, event: 'tool', tool, summary: `${tool} summary`, toolUseId: null, endedAt: null, outcome: null, ...over });
const agent = (id, over = {}) => ({ id, type: 'worker', description: '', model: 'sonnet', status: 'running', lastTool: 'Bash', lastSummary: 'npm test', lastActivityAt: iso(NOW - 20000), waitingPermission: false, tokens: tk(), ...over });
const mk = (activity, over = {}) => ({
  run: { id: 'r', title: 'My run', stage: 'verify', stageName: 'VERIFY', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'VERIFY' }], ...(over.run ?? {}) },
  workflow: { nodes: [], edges: [] }, timeline: [], visits: [], nodes: {}, durationMs: 1000,
  tokens: { nodes: tk(), main: tk(), unattributed: tk(), total: tk() },
  agents: over.agents ?? [agent('a1')],
  activity, // newest first, as the server returns it
});
const model = (activity, over) => toolCalls(mk(activity, over), NOW);

beforeEach(() => { rid = 0; vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('toolCalls model', () => {
  it('only tool rows, newest first, at most 10, with the fields the card needs', () => {
    const act = [];
    for (let i = 0; i < 14; i++) act.push(row('a1', `T${i}`, i * 1000));
    act.splice(2, 0, { id: 900, at: iso(NOW), agentId: 'a1', event: 'error', tool: 'T', summary: 'x', toolUseId: null });
    const out = model(act);
    expect(out).toHaveLength(10);
    expect(out.map((c) => c.tool)).toEqual(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9']);
    for (const k of ['id', 'tool', 'summary', 'agentId', 'agent', 'at', 'endedAt', 'status', 'durationMs', 'error']) expect(k in out[0], k).toBe(true);
    expect(out[0].agent).toBe('worker');
  });

  it('agent label falls back to the agent id when the agent is unknown', () => {
    expect(model([row('main:abc', 'Bash', 1000)])[0].agent).toBe('main:abc');
  });

  it('ok -> success with a duration; error -> error with the text of the error row of the same call', () => {
    const act = [
      { id: 50, at: iso(NOW - 3000), agentId: 'a1', event: 'error', tool: 'Bash', summary: 'exit 2: bad', toolUseId: 'e1' },
      row('a1', 'Bash', 5000, { toolUseId: 'e1', endedAt: iso(NOW - 3000), outcome: 'error' }),
      row('a1', 'Read', 9000, { toolUseId: 'o1', endedAt: iso(NOW - 6700), outcome: 'ok' }),
      row('a1', 'Edit', 9500, { toolUseId: 'e2', endedAt: iso(NOW - 9400), outcome: 'error' }),
    ];
    const out = model(act);
    const byTool = Object.fromEntries(out.map((c) => [c.tool, c]));
    expect(byTool.Bash.status).toBe('error');
    expect(byTool.Bash.error).toBe('exit 2: bad');
    expect(byTool.Bash.durationMs).toBe(2000);
    expect(byTool.Read.status).toBe('success');
    expect(byTool.Read.durationMs).toBe(2300);
    expect(byTool.Read.error ?? null).toBeNull();
    expect(byTool.Edit.status).toBe('error');
    expect(byTool.Edit.error ?? null).toBeNull();
  });

  it('duration is never negative', () => {
    const out = model([row('a1', 'Bash', 1000, { toolUseId: 'x', endedAt: iso(NOW - 5000), outcome: 'ok' })]);
    expect(out[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  describe('a call with no end', () => {
    const open = (extra = {}) => [row('a1', 'Bash', 2000, { toolUseId: 'r1', ...extra })];
    it('is running while its agent runs, the run is open and activity is recent', () => {
      expect(model(open())[0].status).toBe('running');
    });
    it('is unknown (no end recorded) when the run is done or stopped', () => {
      expect(model(open(), { run: { status: 'done' } })[0].status).toBe('unknown');
      expect(model(open(), { run: { status: 'stopped' } })[0].status).toBe('unknown');
    });
    it('is unknown when its agent is finished, missing or not running', () => {
      expect(model(open(), { agents: [agent('a1', { status: 'finished' })] })[0].status).toBe('unknown');
      expect(model(open(), { agents: [] })[0].status).toBe('unknown');
    });
    it('is unknown when the same agent has a later stop-type row', () => {
      for (const event of ['stop', 'session_end', 'subagent_stop', 'stop_failure']) {
        const act = [{ id: 700, at: iso(NOW - 1000), agentId: 'a1', event, tool: null, summary: null, toolUseId: null }, ...open()];
        expect(model(act)[0].status, event).toBe('unknown');
      }
    });
    it('a stop row of another agent does not end it', () => {
      const act = [{ id: 701, at: iso(NOW - 1000), agentId: 'other', event: 'stop', tool: null, summary: null, toolUseId: null }, ...open()];
      expect(model(act, { agents: [agent('a1'), agent('other')] })[0].status).toBe('running');
    });
    it('is unknown when the newest activity of the run is 30 minutes old or more (a main session that never stopped)', () => {
      const old = [row('main:s', 'Bash', 31 * 60000, { toolUseId: 'r9' })];
      expect(model(old, { agents: [agent('main:s')] })[0].status).toBe('unknown');
      const fresh = [row('main:s', 'Bash', 29 * 60000, { toolUseId: 'r9' })];
      expect(model(fresh, { agents: [agent('main:s')] })[0].status).toBe('running');
    });
    it('without a tool_use_id, only the newest tool row of the agent can still be running', () => {
      const act = [row('a1', 'Edit', 1000), row('a1', 'Bash', 4000)];
      const out = model(act);
      expect(out[0].status).toBe('running');
      expect(out[1].status).toBe('unknown');
    });
    it('with a tool_use_id, parallel calls of one agent can all be running', () => {
      const act = [row('a1', 'Edit', 1000, { toolUseId: 'p2' }), row('a1', 'Bash', 4000, { toolUseId: 'p1' })];
      expect(model(act).map((c) => c.status)).toEqual(['running', 'running']);
    });
  });
});

const side = (activity, over) => render(<RunSide detail={mk(activity, over)} onChanged={() => {}} />);
const section = (name) => document.querySelector(`section[aria-label="${name}"]`);

describe('Tool calls section', () => {
  it('replaces "Last activity"; empty state text', () => {
    side([]);
    expect(section('Last activity')).toBeNull();
    expect(screen.queryByText('Last activity')).toBeNull();
    const s = section('Tool calls');
    expect(within(s).getByRole('heading', { level: 3, name: 'Tool calls' })).toBeTruthy();
    expect(s.querySelector('p.muted').textContent).toBe('No tool calls yet.');
  });

  it('renders one card per call with data-status, tool name, summary, agent label and status words', () => {
    side([
      row('a1', 'Bash', 1000, { toolUseId: 'r1', summary: 'npm run build' }),
      row('a1', 'Read', 8000, { toolUseId: 'k1', endedAt: iso(NOW - 5700), outcome: 'ok' }),
      row('a1', 'Edit', 9000, { toolUseId: 'f1', endedAt: iso(NOW - 8000), outcome: 'error' }),
      row('a2', 'Grep', 99000, { toolUseId: 'u1' }),
    ], { agents: [agent('a1'), agent('a2', { status: 'finished' })] });
    const s = section('Tool calls');
    const cards = [...s.querySelectorAll('[data-status]')];
    expect(cards.map((c) => c.getAttribute('data-status'))).toEqual(['running', 'success', 'error', 'unknown']);
    expect(cards[0].querySelector('code.ui-tclc__name').textContent).toBe('Bash');
    expect(cards[0].textContent).toContain('npm run build');
    expect(cards[0].querySelector('.ui-tclc__agent').textContent).toContain('worker');
    expect(cards[0].querySelector('.ui-tclc__spinner')).toBeTruthy();
    expect(cards[1].textContent).toMatch(/2\.3s/);
    expect(cards[1].querySelector('.ui-tclc__ok')).toBeTruthy();
    expect([...cards[1].querySelectorAll('*')].some((e) => e.children.length === 0 && e.textContent.trim().toLowerCase() === 'ok')).toBe(true);
    expect(cards[2].textContent).toMatch(/Failed/);
    expect(cards[3].querySelector('.ui-tclc__spinner')).toBeNull();
    expect(cards[3].querySelector('[title="No end recorded"]')).toBeTruthy();
    expect(cards[3].textContent).toMatch(/No end recorded/);
  });

  it('a card expands with the head button: summary, agent, start time and error text; closed body is inert', () => {
    side([
      { id: 80, at: iso(NOW - 1000), agentId: 'a1', event: 'error', tool: 'Bash', summary: 'exit 7: the real reason', toolUseId: 'f1' },
      row('a1', 'Bash', 4000, { toolUseId: 'f1', endedAt: iso(NOW - 1000), outcome: 'error', summary: 'a very long summary '.repeat(10) }),
      row('a1', 'Edit', 9000, { toolUseId: 'f2', endedAt: iso(NOW - 8000), outcome: 'error' }),
    ]);
    const cards = [...section('Tool calls').querySelectorAll('[data-status]')];
    const head = cards[0].querySelector('button.ui-tclc__head');
    expect(head.getAttribute('aria-expanded')).toBe('false');
    expect(cards[0].querySelector('.ui-tclc__body').hasAttribute('inert')).toBe(true);
    fireEvent.click(head);
    expect(head.getAttribute('aria-expanded')).toBe('true');
    const body = cards[0].querySelector('.ui-tclc__body');
    expect(body.hasAttribute('inert')).toBe(false);
    expect(body.textContent).toContain('a very long summary');
    expect(body.textContent).toContain('worker');
    expect(body.textContent).toContain(new Date(NOW - 4000).toLocaleTimeString());
    expect(body.textContent).toContain('exit 7: the real reason');
    fireEvent.click(cards[1].querySelector('button.ui-tclc__head'));
    expect(cards[1].querySelector('.ui-tclc__body').textContent).toContain('The tool call failed.');
  });

  it('expanded state survives a live refresh that adds a newer call', () => {
    const a = [row('a1', 'Read', 8000, { toolUseId: 'k1', endedAt: iso(NOW - 7000), outcome: 'ok' }), row('a1', 'Bash', 9000, { toolUseId: 'k0', endedAt: iso(NOW - 8500), outcome: 'ok' })];
    const { rerender } = side(a);
    fireEvent.click([...section('Tool calls').querySelectorAll('button.ui-tclc__head')][0]);
    expect(section('Tool calls').querySelectorAll('button.ui-tclc__head')[0].getAttribute('aria-expanded')).toBe('true');
    const newer = row('a1', 'Grep', 500, { toolUseId: 'k2' });
    rerender(<RunSide detail={mk([newer, ...a])} onChanged={() => {}} />);
    const heads = [...section('Tool calls').querySelectorAll('button.ui-tclc__head')];
    expect(heads).toHaveLength(3);
    expect(heads[0].getAttribute('aria-expanded')).toBe('false');
    expect(heads[1].getAttribute('aria-expanded')).toBe('true');
    expect(heads[1].closest('[data-status]').querySelector('code').textContent).toBe('Read');
  });

  it('ten cards do not chatter: no role=status or aria-live inside the Tool calls section', () => {
    const act = []; for (let i = 0; i < 12; i++) act.push(row('a1', `T${i}`, 1000 * (i + 1), { toolUseId: `t${i}`, endedAt: iso(NOW - 500 * i), outcome: i % 3 ? 'ok' : 'error' }));
    side(act);
    const s = section('Tool calls');
    expect(s.querySelectorAll('[data-status]')).toHaveLength(10);
    expect(s.querySelector('[role="status"]')).toBeNull();
    expect(s.querySelector('[aria-live]')).toBeNull();
  });

  it('other sections are unchanged (Status, Active agents, Totals, Timeline)', () => {
    side([]);
    for (const n of ['Status', 'Active agents', 'Totals', 'Timeline']) expect(section(n)).toBeTruthy();
    expect(screen.getByText('npm test')).toBeTruthy();
  });
});

describe('Thinking pill', () => {
  const pills = (li) => li.querySelectorAll('.ui-tlc');
  const agentLis = () => [...section('Active agents').querySelectorAll('li')];

  it('an agent with a running tool call gets one pill labelled with the tool name', () => {
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' })]);
    const [li] = agentLis();
    expect(pills(li)).toHaveLength(1);
    expect(pills(li)[0].textContent).toContain('Bash');
    expect(li.textContent).toContain('npm test');
    expect(li.textContent).not.toMatch(/idle/); // active 1 s ago: no "idle 1s" on a working agent
  });

  it('with no open call but activity under 2 minutes ago, the pill is labelled with the stage', () => {
    side([row('a1', 'Bash', 30000, { toolUseId: 'r1', endedAt: iso(NOW - 25000), outcome: 'ok' })], { agents: [agent('a1', { lastActivityAt: iso(NOW - 30000) })] });
    const [li] = agentLis();
    expect(pills(li)).toHaveLength(1);
    expect(pills(li)[0].textContent).toContain('VERIFY');
  });

  it('no pill when the agent has been quiet for over 2 minutes and has no open call', () => {
    side([row('a1', 'Bash', 300000, { toolUseId: 'r1', endedAt: iso(NOW - 290000), outcome: 'ok' })], { agents: [agent('a1', { lastActivityAt: iso(NOW - 300000) })] });
    expect(pills(agentLis()[0])).toHaveLength(0);
  });

  it('no pill when its newest activity is a stop-type row', () => {
    side([{ id: 500, at: iso(NOW - 2000), agentId: 'a1', event: 'stop', tool: null, summary: null, toolUseId: null }, row('a1', 'Bash', 5000, { toolUseId: 'r1', endedAt: iso(NOW - 4000), outcome: 'ok' })]);
    expect(pills(agentLis()[0])).toHaveLength(0);
  });

  it('no pill while waiting for permission, when the run is done or stopped, or when there is no activity row', () => {
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' })], { agents: [agent('a1', { waitingPermission: true })] });
    expect(pills(agentLis()[0])).toHaveLength(0);
    document.body.innerHTML = '';
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' })], { run: { status: 'done' } });
    expect(document.querySelectorAll('.ui-tlc')).toHaveLength(0);
    document.body.innerHTML = '';
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' })], { run: { status: 'stopped' } });
    expect(document.querySelectorAll('.ui-tlc')).toHaveLength(0);
    document.body.innerHTML = '';
    side([]);
    expect(document.querySelectorAll('.ui-tlc')).toHaveLength(0);
  });

  it('a finished agent is not listed and has no pill; two working agents get one pill each', () => {
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' }), row('a2', 'Read', 2000, { toolUseId: 'r2' }), row('a3', 'Grep', 3000, { toolUseId: 'r3' })],
      { agents: [agent('a1'), agent('a2', { type: 'lead' }), agent('a3', { status: 'finished' })] });
    const lis = agentLis();
    expect(lis).toHaveLength(2);
    for (const li of lis) expect(pills(li)).toHaveLength(1);
    expect(pills(lis[1])[0].textContent).toContain('Read');
    expect(document.querySelectorAll('.ui-tlc')).toHaveLength(2);
  });

  it('two open calls of one agent still give one pill', () => {
    side([row('a1', 'Edit', 500, { toolUseId: 'r2' }), row('a1', 'Bash', 1000, { toolUseId: 'r1' })]);
    expect(pills(agentLis()[0])).toHaveLength(1);
  });

  it('no aria-live and no role=status inside the Active agents section', () => {
    side([row('a1', 'Bash', 1000, { toolUseId: 'r1' })]);
    const s = section('Active agents');
    expect(s.querySelector('.ui-tlc')).toBeTruthy();
    expect(s.querySelector('[aria-live]')).toBeNull();
    expect(s.querySelector('[role="status"]')).toBeNull();
  });
});
