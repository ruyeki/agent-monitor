// The P1 / P2 findings of the Impeccable critique (2026-11-23) that change behaviour: agent labels, the quiet Now card, the
// shared Totals, unknown cost, the stop-edge toggle, phone scrolling, the sidebar and the inbox order.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';
import { StageStats } from '../src/stats/StageStats.jsx';
import { RunView } from '../src/run/RunView.jsx';
import { Sidebar } from '../src/Sidebar.jsx';
import { sample } from './fixtures.js';

// React Flow draws nothing useful in jsdom (no node sizes), so the graph is a stand-in that shows what RunGraph passes it.
vi.mock('@xyflow/react', async (importOriginal) => ({
  ...(await importOriginal()),
  ReactFlow: (p) => (
    <div data-testid="flow" data-edges={p.edges.map((e) => e.id).join(',')} data-fit={(p.fitViewOptions.nodes ?? []).map((n) => n.id).join(',')} data-pan={String(p.panOnDrag)}>
      {p.children}
    </div>
  ),
  Background: () => null,
  Controls: (p) => <div data-testid="controls" data-position={p.position} />,
}));

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const tk = (total, cost = 0) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });
const agent = (id, type, over = {}) => ({ id, type, description: '', model: 'claude-sonnet-5-5-20261001', status: 'running', parentId: null, context: null, lastActivityAt: iso(NOW - 3000), startedAt: iso(NOW - 600_000), tokens: tk(1, 0.5), ...over });

const detail = (over = {}) => ({
  run: { id: 'r1', title: 'My run', stage: 'verify', stageName: 'Verify', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'Verify', type: 'check' }], actions: [], createdAt: iso(NOW - 3_600_000), updatedAt: iso(NOW - 1000) },
  workflow: sample(), timeline: [], visits: [{ node: 'verify', outcome: null }], nodes: {}, durationMs: 65_000,
  agents: [
    agent('lead', 'fable-lead', { description: 'Plans, delegates and reviews the work', model: 'claude-opus-5-5-20261001' }),
    agent('e1', 'sonnet-engineer', { description: 'Restyle the Monitor', parentId: 'lead', lastActivityAt: iso(NOW - 14_000) }),
    agent('e2', 'sonnet-engineer', { description: 'Write the tests', parentId: 'lead', lastActivityAt: iso(NOW - 150_000) }),
  ],
  activity: [
    { id: 3, at: iso(NOW - 1000), agentId: 'e1', event: 'tool', tool: 'Edit', summary: 'a.js', toolUseId: 't3', endedAt: iso(NOW - 900), outcome: 'ok' },
    { id: 2, at: iso(NOW - 2000), agentId: 'e2', event: 'tool', tool: 'Grep', summary: 'b.js', toolUseId: 't2', endedAt: iso(NOW - 1900), outcome: 'ok' },
  ],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(3_000_000, 1.86) },
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
  vi.unstubAllGlobals();
});

describe('agents-indistinguishable: same-named agents get a number', () => {
  it('Crew: the cards, the tool-call rail and the filter button use the same labels; the lead is not a reviewer', async () => {
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    const names = [...document.querySelectorAll('article[data-agent-id] .nm')].map((b) => b.textContent);
    expect(names).toEqual(['fable-lead', 'sonnet-engineer 1', 'sonnet-engineer 2']);
    expect(document.querySelector('article[data-agent-id="lead"] .av').textContent).toBe('L');
    const rail = screen.getByRole('region', { name: 'Tool calls' });
    expect([...rail.querySelectorAll('.ui-tclc__agent')].map((e) => e.textContent).sort()).toEqual(['sonnet-engineer 1', 'sonnet-engineer 2']);
    fireEvent.click(within(document.querySelector('article[data-agent-id="e2"]')).getByRole('button', { name: 'sonnet-engineer 2' }));
    const clear = await within(rail).findByRole('button', { name: 'Clear filter (sonnet-engineer 2)' });
    expect(clear).toBeTruthy();
    expect(within(rail).queryByText('sonnet-engineer 1')).toBeNull();
    expect(rail.querySelector('.ui-tclc__agent')).toBeNull(); // filtered to one agent: the agent column is redundant
  });

  it('Stages: the Now card names the same agents the same way, with the model label', async () => {
    render(<RunView id="r1" tab="stages" />);
    const now = within(await screen.findByRole('region', { name: 'Active agents' }));
    expect(now.getByText('sonnet-engineer 1')).toBeTruthy();
    expect(now.getByText('sonnet-engineer 2')).toBeTruthy();
    expect(now.queryByText(/claude-sonnet-5-5-20261001/)).toBeNull();
    expect(screen.getAllByText(/Sonnet 5\.5/).length).toBeGreaterThan(0);
  });
});

describe('now-totals-two-designs', () => {
  it('Crew has no Now card; Crew and Stages share one Totals card', async () => {
    const { unmount } = render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    expect(screen.queryByRole('region', { name: 'Now' })).toBeNull();
    const crewTotals = screen.getByRole('region', { name: 'Totals' }).innerHTML;
    unmount();
    render(<RunView id="r1" tab="stages" />);
    await screen.findByRole('region', { name: 'Active agents' });
    expect(screen.getByRole('region', { name: 'Totals' }).innerHTML).toBe(crewTotals);
  });

  it('a running agent is not "idle"; "no activity for" shows only after a minute', async () => {
    render(<RunView id="r1" tab="stages" />);
    const items = (await screen.findByRole('region', { name: 'Active agents' })).querySelectorAll('li');
    expect(items[0].textContent).not.toMatch(/idle|no activity/); // the lead was active 3 s ago
    expect(items[1].textContent).not.toMatch(/idle|no activity/); // active 14 s ago
    expect(items[2].textContent).toContain('no activity for 2m'); // active 150 s ago
  });
});

describe('unknown-cost-shows-zero', () => {
  it('an agent with no cost reads a dash, and Totals says "not priced yet" when only the agents have tokens', async () => {
    current = detail({
      agents: [agent('lead', 'fable-lead', { tokens: { input: 5, output: 5, cacheWrite: 0, cacheRead: 0, total: 400_000 } }), agent('e1', 'sonnet-engineer', { tokens: undefined })],
      tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(0, 0) },
    });
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    expect(document.querySelector('article[data-agent-id="e1"] .agfoot').textContent).not.toContain('$0.00');
    const totals = screen.getByRole('region', { name: 'Totals' }).textContent;
    expect(totals).toContain('Not priced yet');
    expect(totals).toContain('Cost–');
    expect(totals).toContain('Tokens400k');
  });

  it('a real zero stays $0.00 when nothing reported tokens', async () => {
    current = detail({ agents: [], tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(0, 0) } });
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    const totals = screen.getByRole('region', { name: 'Totals' }).textContent;
    expect(totals).toContain('Cost$0.00');
    expect(totals).not.toContain('Not priced yet');
  });
});

describe('stages-graph-framing: stop edges are behind a toggle', () => {
  it('"Show stop edges" starts off and adds the Stop run edge back', async () => {
    render(<RunView id="r1" tab="stages" />);
    const flow = await screen.findByTestId('flow');
    const btn = screen.getByRole('button', { name: 'Show stop edges' });
    expect(btn.getAttribute('aria-pressed')).toBe('false');
    const ids = (el) => el.getAttribute('data-edges').split(',');
    const hidden = ids(flow);
    expect(hidden).toHaveLength(sample().edges.length - 1); // gate2 -Stop run-> done is left out
    fireEvent.click(btn);
    expect(btn.getAttribute('aria-pressed')).toBe('true');
    expect(ids(screen.getByTestId('flow'))).toHaveLength(sample().edges.length);
  });

  it('opens framed on the stage the run is at, and on a phone lets the page scroll and moves the controls up', async () => {
    const { unmount } = render(<RunView id="r1" tab="stages" />);
    expect((await screen.findByTestId('flow')).getAttribute('data-fit')).toBe('verify');
    expect(screen.getByTestId('flow').getAttribute('data-pan')).toBe('true');
    unmount();
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('768'), media: q, addEventListener() {}, removeEventListener() {} }));
    render(<RunView id="r1" tab="stages" />);
    expect((await screen.findByTestId('flow')).getAttribute('data-pan')).toBe('false');
    expect(screen.getByTestId('controls').getAttribute('data-position')).toBe('top-right');
  });
});

describe('phone-agent-select-offscreen', () => {
  it('on a narrow screen, picking an agent scrolls the tool calls into view; on a wide one it does not; clearing does not', async () => {
    const scroll = vi.fn();
    Element.prototype.scrollIntoView = scroll;
    vi.stubGlobal('matchMedia', (q) => ({ matches: q.includes('768'), media: q, addEventListener() {}, removeEventListener() {} }));
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    const hit = () => document.querySelector('article[data-agent-id="e1"] .nm');
    fireEvent.click(hit());
    expect(scroll).toHaveBeenCalledTimes(1);
    expect(scroll.mock.contexts[0].getAttribute('aria-label')).toBe('Tool calls');
    fireEvent.click(hit()); // second click clears the filter
    expect(scroll).toHaveBeenCalledTimes(1);
    vi.stubGlobal('matchMedia', (q) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} }));
    fireEvent.click(hit());
    expect(scroll).toHaveBeenCalledTimes(1);
  });
});

describe('crew-equal-weight: finished agents are marked for the quieter style', () => {
  it('a finished agent card carries a Done pill (styles.css quiets .ag:has(.pill.done))', async () => {
    current = detail({ agents: [agent('e1', 'sonnet-engineer', { status: 'finished' }), agent('e2', 'sonnet-engineer')] });
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    expect(document.querySelector('article[data-agent-id="e1"] .pill.done')).toBeTruthy();
    expect(document.querySelector('article[data-agent-id="e2"] .pill.done')).toBeNull();
  });
});

describe('sidebar-two-selected', () => {
  const props = { current: 'stats', openCount: 1, counts: { waiting: 1, active: 1, finished: 1 }, query: '', onQuery() {}, searchRef: { current: null }, view: 'active', onView() {}, connection: 'live', theme: 'light', onTheme() {} };
  it('a Views filter shows as pressed only on Monitor', () => {
    const { rerender } = render(<Sidebar {...props} />);
    const running = () => within(screen.getByRole('navigation', { name: 'Views' })).getByRole('button', { name: /Running/ });
    expect(running().getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('link', { name: /Stats/ }).getAttribute('aria-current')).toBe('page');
    rerender(<Sidebar {...props} current="monitor" routeName="run" />); // a run page: current is Monitor, the route is not
    expect(running().getAttribute('aria-pressed')).toBe('false');
    rerender(<Sidebar {...props} current="monitor" routeName="monitor" />);
    expect(running().getAttribute('aria-pressed')).toBe('true');
  });
});

describe('inbox-below-kpis', () => {
  const waiting = { id: 'w1', title: 'Wait', stage: 'gate1', stageName: 'Gate', round: 1, maxRounds: 5, status: 'waiting', ask: 'Q?', actions: [{ label: 'Agree' }], textField: false, updatedAt: iso(NOW - 5000), createdAt: iso(NOW - 9000) };
  const mount = (groups) => render(<Monitor groups={groups} query="" view={null} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={() => {}} />);
  const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('with a question waiting, the inbox comes before the KPI strip; with none, the strip stays first', () => {
    const { unmount } = mount({ waiting: [waiting], active: [], finished: [] });
    expect(before(screen.getByRole('complementary', { name: 'Decision inbox' }), screen.getByRole('region', { name: 'Today' }))).toBe(true);
    unmount();
    mount({ waiting: [], active: [], finished: [] });
    expect(before(screen.getByRole('region', { name: 'Today' }), screen.getByRole('complementary', { name: 'Decision inbox' }))).toBe(true);
  });
});

describe('P3: the Now card names an agent once', () => {
  it('the main session shows "Main session" once, even when its description says the same', async () => {
    current = detail({ agents: [agent('main:s1', 'main', { description: 'Main session' }), agent('e1', 'sonnet-engineer', { description: 'Restyle the Monitor' })] });
    render(<RunView id="r1" tab="stages" />);
    const now = await screen.findByRole('region', { name: 'Active agents' });
    const line = now.querySelector('li .agent-line');
    expect(line.textContent.match(/Main session/g)).toHaveLength(1);
    expect(now.textContent).toContain('Restyle the Monitor'); // a description that adds something stays
    cleanup();
    render(<RunView id="r1" tab="crew" />);
    await screen.findByRole('region', { name: 'Crew' });
    expect(document.querySelector('article[data-agent-id="main:s1"]').textContent.match(/Main session/g)).toHaveLength(1);
  });
});

describe('P3: run tabs follow the ARIA tab pattern', () => {
  const tabs = () => within(screen.getByRole('tablist', { name: 'Run views' })).getAllByRole('tab');
  it('only the selected tab is in the tab order; arrows, Home and End move focus and open the tab', async () => {
    render(<RunView id="r1" tab="stages" />);
    await screen.findByRole('tablist', { name: 'Run views' });
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]); // Crew, Stages, Ledger
    tabs()[1].focus();
    fireEvent.keyDown(tabs()[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(tabs()[2]);
    expect(window.location.hash).toBe('#/runs/r1/ledger');
    fireEvent.keyDown(tabs()[2], { key: 'ArrowRight' }); // wraps
    expect(document.activeElement).toBe(tabs()[0]);
    expect(window.location.hash).toBe('#/runs/r1/crew');
    fireEvent.keyDown(tabs()[0], { key: 'ArrowLeft' }); // wraps back
    expect(document.activeElement).toBe(tabs()[2]);
    fireEvent.keyDown(tabs()[2], { key: 'Home' });
    expect(document.activeElement).toBe(tabs()[0]);
    fireEvent.keyDown(tabs()[0], { key: 'End' });
    expect(document.activeElement).toBe(tabs()[2]);
    expect(window.location.hash).toBe('#/runs/r1/ledger');
  });
});

describe('P3: copy', () => {
  it('the timeline names the stage, not its id', async () => {
    current = detail({ timeline: [{ at: iso(NOW - 5000), kind: 'answer', stage: 'gate2', round: 0 }] });
    render(<RunView id="r1" tab="stages" />);
    const tl = within(await screen.findByRole('region', { name: 'Timeline' }));
    expect(tl.getByText('GATE2')).toBeTruthy(); // sample() names its nodes in capitals; the id is "gate2"
    expect(tl.queryByText(/gate2/)).toBeNull();
  });

  it('the graph legend says "you" and draws SVG icons, no Unicode glyphs', async () => {
    render(<RunView id="r1" tab="stages" />);
    const legend = await screen.findByRole('group', { name: 'Colour legend' });
    expect(legend.textContent).toContain('Waiting on you');
    expect(legend.textContent).not.toMatch(/Ryan|[✓✕⏸▶]/);
    expect(legend.querySelectorAll('svg')).toHaveLength(5);
  });

  it('Stats: no finished token data shows one line, not an empty donut', () => {
    const v = [{ version: 1, publishedAt: iso(NOW), finishedRuns: 2, avgTokens: 0, avgCost: 0, avgDurationMs: 0, nodes: [{ id: 'plan', name: 'PLAN', runs: 2, avgTokens: 0, avgCost: 0, avgDurationMs: 0 }] }];
    render(<StageStats versions={v} metric="cost" />);
    expect(screen.getByText(/No finished run has token data yet/)).toBeTruthy();
    expect(document.querySelector('svg[role="img"]')).toBeNull();
  });
});

describe('P3: finished rows and the Finished view', () => {
  const done = (id, over = {}) => ({ id, title: `Run ${id}`, stage: 'done', stageName: 'Done', round: 0, maxRounds: 5, status: 'done', updatedAt: iso(NOW - 1000), createdAt: iso(NOW - 9000), endedAt: iso(NOW - 1000), ...over });
  const mount = (finished, view = null) => render(<Monitor groups={{ waiting: [], active: [], finished }} query="" view={view} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={() => {}} />);

  it('a finished row does not repeat its end state as a stage pill, and hides "round 0"', () => {
    mount([done('a'), done('b', { status: 'stopped', stageName: 'Verify', round: 2 })], 'finished');
    const row = (id) => document.querySelector(`a.run-row[href^="#/runs/${id}"]`);
    expect(row('a').querySelector('.stage-pill')).toBeNull();
    expect(row('a').querySelector('.run-rounds')).toBeNull();
    expect(row('b').querySelector('.stage-pill').textContent).toBe('Verify'); // a stage that says something new stays
    expect(row('b').querySelector('.run-rounds').textContent).toContain('2/5');
  });

  it('the Finished view has a plain header; on Monitor the group folds, with an SVG chevron', () => {
    const { unmount } = mount([done('a')], 'finished');
    expect(document.querySelector('details.finished')).toBeNull();
    expect(document.querySelector('.run-group .group-head')).toBeTruthy();
    expect(document.querySelector('.group-chevron')).toBeNull();
    unmount();
    mount([done('a')]);
    expect(document.querySelector('details.finished .group-head svg.group-chevron')).toBeTruthy();
  });
});

describe('P3: the waiting count', () => {
  const waiting = { id: 'w1', title: 'Wait', stage: 'gate1', stageName: 'Gate', round: 1, maxRounds: 5, status: 'waiting', ask: 'Q?', actions: [{ label: 'Agree' }], textField: false, updatedAt: iso(NOW - 5000), createdAt: iso(NOW - 9000) };
  const mount = (waitingRuns) => render(<Monitor groups={{ waiting: waitingRuns, active: [], finished: [] }} query="" view={null} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={() => {}} />);
  const labels = () => [...document.querySelectorAll('section.stat-strip .stat-label')].map((l) => l.textContent);

  it('the Needs you tile is dropped while the inbox shows the question (the note keeps the oldest wait); it stays when nothing waits', () => {
    const { unmount } = mount([waiting]);
    expect(labels()).not.toContain('Needs you');
    expect(document.querySelector('.inbox-note').textContent).toMatch(/Oldest waiting 5s ago\. Answered questions confirm, then fold away\./);
    unmount();
    mount([]);
    expect(labels()).toContain('Needs you');
  });
});
