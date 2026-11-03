// Holdout AC1/AC2/AC5: the shared card and the run-view colours, through the real RunView. Vitest + jsdom.
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/run/RunView.jsx';
import { toFlow } from '../src/editor/toFlow.js';
import { formatTokens } from '../src/lib/format.js';
import { seedWorkflow } from '../../src/workflow.js';

const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const T0 = Date.parse('2026-10-27T12:00:00Z');
let t = 0;
const visit = (node, outcome, open = false) => {
  t += 1000;
  return { node, enteredAt: new Date(T0 + t).toISOString(), leftAt: open ? null : new Date(T0 + t + 500).toISOString(), outcome: open ? null : outcome };
};
const NODE_TYPE = Object.fromEntries(seedWorkflow().nodes.map((n) => [n.id, n.type]));
const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 };

function detail({ visits = [], active = [], status = 'active' } = {}) {
  const counts = {};
  for (const v of visits) counts[v.node] = (counts[v.node] ?? 0) + 1;
  return {
    run: { id: 'r1', title: 'R', stage: active[0] ?? 'done', stageName: 'x', round: 0, maxRounds: 5, status, ask: null, actions: [], textField: false, active: active.map((id) => ({ id, name: id, type: NODE_TYPE[id] })) },
    workflow: seedWorkflow(),
    timeline: [], agents: [], activity: [], visits,
    nodes: Object.fromEntries(Object.entries(counts).map(([id, n]) => [id, { visits: n, durationMs: 1000 }])),
    durationMs: 1000,
    tokens: { nodes: zero, main: zero, unattributed: zero, total: zero },
  };
}
const mount = async (d) => {
  globalThis.fetch = vi.fn(() => res(d));
  const r = render(<RunView id="r1" />);
  await screen.findByRole('group', { name: 'Run graph' });
  await waitFor(() => expect(document.querySelector('[data-node="frame"]')).toBeTruthy());
  return r;
};
const el = (id) => document.querySelector(`[data-node="${id}"]`);
const state = (id) => el(id).getAttribute('data-state');
const status = (id) => el(id).querySelector('.fnode-status')?.textContent.trim() ?? null;
beforeEach(() => { t = 0; });
afterEach(() => vi.restoreAllMocks());

describe('run view node states', () => {
  it('running: an active step/check is blue with "running" text', async () => {
    await mount(detail({ active: ['verify'], visits: [visit('verify', null, true)] }));
    expect(state('verify')).toBe('running');
    expect(el('verify').className).toContain('run-running');
    expect(status('verify')).toBe('▶ running');
  });
  it('waiting: an active normal gate is amber, "waiting on Ryan"', async () => {
    await mount(detail({ active: ['gate1'], status: 'waiting', visits: [visit('frame', 'done'), visit('gate1', null, true)] }));
    expect(state('gate1')).toBe('waiting');
    expect(el('gate1').className).toContain('run-waiting');
    expect(status('gate1')).toBe('⏸ waiting on Ryan');
  });
  it('decision: the loop.decision gate while active is red, "decision needed"', async () => {
    await mount(detail({ active: ['decision'], status: 'waiting', visits: [visit('verify', 'regression'), visit('decision', null, true)] }));
    expect(state('decision')).toBe('decision');
    expect(el('decision').className).toContain('run-decision');
    expect(status('decision')).toBe('✕ decision needed');
  });
  it.each(['fail', 'finding', 'regression', 'env', 'stuck'])('failed: latest outcome %s is red with the outcome in the text', async (o) => {
    await mount(detail({ active: ['fix'], visits: [visit('verify', o), visit('fix', null, true)] }));
    expect(state('verify')).toBe('failed');
    expect(el('verify').className).toContain('run-failed');
    expect(status('verify')).toBe(`✕ ${o}`);
  });
  it.each(['pass', 'done'])('passed: latest outcome %s is green with a check mark', async (o) => {
    await mount(detail({ active: ['gate1'], status: 'waiting', visits: [visit('plan', o), visit('gate1', null, true)] }));
    expect(state('plan')).toBe('passed');
    expect(el('plan').className).toContain('run-passed');
    expect(status('plan')).toBe(`✓ ${o}`);
  });
  it('an answered gate is passed and shows the action label', async () => {
    await mount(detail({ active: ['plan'], visits: [visit('gate1', 'Agree spec'), visit('plan', null, true)] }));
    expect(state('gate1')).toBe('passed');
    expect(status('gate1')).toBe('✓ Agree spec');
  });
  it('halted: stopped / cancelled are grey with a dash text', async () => {
    await mount(detail({ status: 'stopped', visits: [visit('implement', 'cancelled'), visit('verify', 'stopped')] }));
    expect(state('implement')).toBe('halted');
    expect(status('implement')).toBe('– cancelled');
    expect(state('verify')).toBe('halted');
    expect(status('verify')).toBe('– stopped');
    expect(el('verify').className).toContain('run-halted');
  });
  it('idle: no visit is grey with no status text', async () => {
    await mount(detail({ active: ['plan'], visits: [visit('plan', null, true)] }));
    expect(state('pr')).toBe('idle');
    expect(el('pr').className).toContain('run-idle');
    expect(status('pr')).toBeNull();
  });
  it('end node is passed when the run is done; the other end node stays idle', async () => {
    await mount(detail({ status: 'done', visits: [visit('pr', 'done'), visit('done', null)] }));
    expect(state('done')).toBe('passed');
    expect(state('stopped')).toBe('idle');
  });
  it('end node visited while the run is not done is halted', async () => {
    await mount(detail({ status: 'stopped', visits: [visit('gate1', 'Stop run'), visit('stopped', null)] }));
    expect(state('stopped')).toBe('halted');
  });
  it('split and join are passed when a direct target was visited', async () => {
    await mount(detail({ active: ['verify'], visits: [visit('plan', 'done'), visit('implement', 'done'), visit('prep', 'done'), visit('verify', null, true)] }));
    expect(state('split')).toBe('passed');
    expect(state('join')).toBe('passed');
  });
  it('split and join are idle while no target was visited', async () => {
    await mount(detail({ active: ['plan'], visits: [visit('plan', null, true)] }));
    expect(state('split')).toBe('idle');
    expect(state('join')).toBe('idle');
  });
});

describe('latest visit wins and earlier failures are counted', () => {
  it('fail, finding, pass -> passed with "2 fails"', async () => {
    await mount(detail({ active: ['review'], visits: [visit('verify', 'fail'), visit('verify', 'finding'), visit('verify', 'pass'), visit('review', null, true)] }));
    expect(state('verify')).toBe('passed');
    expect(el('verify').querySelector('.badge.fails').textContent).toMatch(/2 fails/);
  });
  it('fail, pass -> "1 fail" (singular)', async () => {
    await mount(detail({ active: ['review'], visits: [visit('verify', 'fail'), visit('verify', 'pass'), visit('review', null, true)] }));
    expect(el('verify').querySelector('.badge.fails').textContent.trim()).toMatch(/^1 fail$/);
  });
  it('pass, fail -> failed and no fails badge (only visits before the latest count)', async () => {
    await mount(detail({ active: ['fix'], visits: [visit('verify', 'pass'), visit('verify', 'fail'), visit('fix', null, true)] }));
    expect(state('verify')).toBe('failed');
    expect(el('verify').querySelector('.badge.fails')).toBeNull();
  });
  it('fail, then running again -> running with "1 fail"', async () => {
    await mount(detail({ active: ['verify'], visits: [visit('verify', 'fail'), visit('fix', 'done'), visit('verify', null, true)] }));
    expect(state('verify')).toBe('running');
    expect(el('verify').querySelector('.badge.fails').textContent).toMatch(/1 fail/);
  });
  it('a node with no failures has no fails badge', async () => {
    await mount(detail({ active: ['gate1'], status: 'waiting', visits: [visit('frame', 'done'), visit('gate1', null, true)] }));
    expect(el('frame').querySelector('.badge.fails')).toBeNull();
  });
});

describe('card DOM contract', () => {
  it('has icon, name, type badge, runner · model, pushes badge, and no old active/visited marks', async () => {
    await mount(detail({ active: ['verify'], visits: [visit('plan', 'done'), visit('verify', null, true)] }));
    const v = el('verify');
    expect(v.className).toContain('fnode');
    expect(v.className).toContain('type-check');
    expect(v.querySelector('.fnode-icon')?.getAttribute('aria-hidden')).toBe('true');
    expect(v.querySelector('.fnode-name').textContent).toBe('Verify');
    expect(v.querySelector('.fnode-type').textContent.trim().length).toBeGreaterThan(0);
    expect(v.querySelector('.fnode-sub').textContent).toBe('verifier · sonnet');
    expect(el('pr').querySelector('.badge.pushes').textContent).toBe('pushes');
    expect(el('gate1').querySelector('.fnode-sub')).toBeNull();
    expect(el('plan').className).not.toMatch(/\bvisited\b/);
    expect(v.className).not.toMatch(/\bactive\b/);
    expect(document.querySelector('.badge.here')).toBeNull();
  });
  it('handles: target on top, source at the bottom, none left/right; end has no source', async () => {
    await mount(detail());
    const v = el('verify');
    expect(v.querySelector('.react-flow__handle-top')).toBeTruthy();
    expect(v.querySelector('.react-flow__handle-bottom')).toBeTruthy();
    expect(v.querySelector('.react-flow__handle-left')).toBeNull();
    expect(v.querySelector('.react-flow__handle-right')).toBeNull();
    expect(el('done').querySelector('.react-flow__handle-bottom')).toBeNull();
    expect(el('done').querySelector('.react-flow__handle-top')).toBeTruthy();
  });
  it('run view keeps token and visit counts', async () => {
    const d = detail({ active: ['verify'], visits: [visit('plan', 'done'), visit('plan', 'done'), visit('verify', null, true)] });
    d.nodes.plan.tokens = { total: 12345 };
    await mount(d);
    expect(el('plan').textContent).toContain(`${formatTokens(12345)} tokens`);
    expect(el('plan').textContent).toContain('2 visits');
    expect(el('verify').textContent).toContain('1 visit');
  });
  it('has no editor stats line in the run view', async () => {
    await mount(detail());
    expect(document.querySelector('.fnode-stats')).toBeNull();
  });
  it('shows a colour legend with an icon or text for every state', async () => {
    await mount(detail());
    const lg = document.querySelector('.run-legend');
    expect(lg).toBeTruthy();
    expect(lg.getAttribute('aria-label')).toBe('Colour legend');
    for (const w of [/passed/i, /failed/i, /waiting on ryan/i, /running/i, /not reached|stopped/i, /✓/, /✕/, /⏸/, /▶/]) expect(lg.textContent).toMatch(w);
  });
});

describe('toFlow edges', () => {
  it('labels are the outcome/action only; fixRound edges get edge-fix, combined with edge-error', () => {
    const { edges } = toFlow(seedWorkflow(), { errors: { nodes: new Set(), edges: new Set(['verify>fix:fail']) } });
    const wf = seedWorkflow();
    for (const ed of edges) expect(ed.label ?? '').not.toMatch(/fix round/i);
    const byId = Object.fromEntries(edges.map((x) => [x.id, x]));
    // grouping rule: first edge of each from>to group carries the joined `on` values, the others no label
    const groups = new Map();
    for (const e of wf.edges) { const k = `${e.from}>${e.to}`; groups.set(k, [...(groups.get(k) ?? []), e]); }
    for (const g of groups.values()) {
      expect(byId[g[0].id].label).toBe(g.length === 1 ? g[0].on : g.map((e) => e.on).join(' / '));
      for (const e of g.slice(1)) expect(byId[e.id].label ?? '').toBe('');
    }
    expect([...groups.values()].some((g) => g.length > 1)).toBe(true);
    expect(byId['verify>fix:fail'].className).toMatch(/edge-fix/);
    expect(byId['verify>fix:fail'].className).toMatch(/edge-error/);
    expect(byId['review>fix:finding'].className).toMatch(/edge-fix/);
    expect(byId['verify>review:pass'].className ?? '').not.toMatch(/edge-fix/);
    expect(byId['gate1>plan:Agree spec'].label).toBe('Agree spec');
  });
});
