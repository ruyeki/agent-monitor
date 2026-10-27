import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeRun } from '../src/attribution.js';
import { seedWorkflow } from '../src/workflow.js';
import { SEED_PRICES } from '../src/prices.js';

const at = (hhmmss) => `2026-10-20T${hhmmss}.000Z`;
const msg = (id, ts, agentId, sessionId, o = {}) => ({ id, ts: at(ts), day: '2026-10-20', sessionId, agentId, model: 'claude-opus-5',
  input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, ...o });

const run = { createdAt: at('10:00:00'), endedAt: at('10:45:00') };
const visits = [
  { node: 'plan', enteredAt: at('10:00:00'), leftAt: at('10:10:00') },
  { node: 'implement', enteredAt: at('10:10:00'), leftAt: at('10:30:00') },
  { node: 'prep', enteredAt: at('10:10:00'), leftAt: at('10:20:00') },
  { node: 'verify', enteredAt: at('10:30:00'), leftAt: at('10:40:00') },
];
const agents = [
  { id: 'main:S', type: 'main', startNodes: [], reportedNodes: [] },
  { id: 'lead1', type: 'fable-lead', description: '', startNodes: ['plan'], reportedNodes: [] },
  { id: 'w1', type: 'sonnet-engineer', description: 'Implement the thing', startNodes: ['implement', 'prep'], reportedNodes: [] },
  { id: 'v1', type: 'verifier', description: 'Verifier prep', startNodes: ['implement', 'prep'], reportedNodes: [] },
  { id: 'one', type: 'general-purpose', description: 'whatever', startNodes: ['plan'], reportedNodes: ['verify'] },
  { id: 'blind', type: 'x', description: 'no hint', startNodes: ['implement', 'prep'], reportedNodes: [] },
  { id: 'lost', type: 'x', description: '', startNodes: [], reportedNodes: [] },
  { id: 'reporter', type: 'x', description: '', startNodes: [], reportedNodes: ['plan', 'verify'] }, // 2 distinct reports: acts as a lead
];
const messages = [
  msg('l1', '10:05:00', 'lead1', 'S', { input: 100, output: 10 }), // plan only
  msg('l2', '10:15:00', 'lead1', 'S', { input: 101, output: 3, cacheRead: 7 }), // implement + prep: split 51/50
  msg('l3', '10:25:00', 'lead1', 'S', { input: 40 }), // implement only
  msg('l4', '10:50:00', 'lead1', 'S', { input: 9 }), // no visit: unattributed
  msg('w', '10:12:00', 'w1', 'S', { input: 1000, output: 100 }), // resolved by description: implement
  msg('v', '10:13:00', 'v1', 'S', { input: 500, output: 50 }), // resolved by runner word: prep
  msg('o', '10:35:00', 'one', 'S', { output: 77 }), // single report: verify
  msg('b', '10:14:00', 'blind', 'S', { input: 5 }), // only worker start: implement
  msg('x', '10:14:00', 'lost', 'S', { input: 3 }), // nowhere to go
  msg('r', '10:32:00', 'reporter', 'S', { input: 8 }), // lead-like, verify window
  msg('m1', '10:01:00', null, 'S', { input: 11, output: 22, cacheWrite: 33, cacheRead: 44 }), // main session
  msg('m2', '09:59:59', null, 'S', { input: 9999 }), // before the run
  msg('m3', '10:46:00', null, 'S', { input: 8888 }), // after the run ended
  msg('f', '10:02:00', null, 'OTHER', { input: 7777 }), // foreign session
  msg('g', '10:02:00', 'ghost', 'S', { input: 6666 }), // agent not in the run
];
const wf = seedWorkflow();
const go = (extra = {}) => attributeRun({ run, workflow: wf, visits, agents, messages, mainSessions: ['S'], prices: SEED_PRICES, now: Date.parse(at('11:00:00')), ...extra });

test('lead tokens follow visit windows, parallel visits split evenly with the remainder to the first', () => {
  const r = go();
  assert.equal(r.nodes.plan.input, 100);
  // implement: 51 of l2 + 40 of l3 + w1 1000 + blind 5 ; prep: 50 of l2 + v1 500
  assert.equal(r.nodes.implement.input, 51 + 40 + 1000 + 5);
  assert.equal(r.nodes.prep.input, 50 + 500);
  assert.equal(r.nodes.implement.output, 2 + 100); // 3 output split 2/1
  assert.equal(r.nodes.prep.output, 1 + 50);
  assert.equal(r.nodes.implement.cacheRead, 4);
  assert.equal(r.nodes.prep.cacheRead, 3);
});

test('subagents resolve by description, runner word, single report, or fallback; roles are reported', () => {
  const r = go();
  assert.deepEqual([r.agents.w1.node, r.agents.v1.node, r.agents.one.node, r.agents.blind.node, r.agents.lost.node], ['implement', 'prep', 'verify', 'implement', null]);
  assert.equal(r.nodes.verify.output, 77);
  assert.equal(r.nodes.verify.input, 8); // the two-report agent is lead-like: window 10:30-10:40
  assert.deepEqual([r.agents.lead1.role, r.agents.reporter.role, r.agents.w1.role], ['lead', 'lead', 'subagent']);
  assert.equal(r.agents.w1.tokens.total, 1100);
  assert.equal(r.agents.lead1.tokens.input, 250);
});

test('main-session tokens are run-level; out-of-window, foreign-session and unknown-agent messages are ignored', () => {
  const r = go();
  assert.deepEqual([r.main.input, r.main.output, r.main.cacheWrite, r.main.cacheRead, r.main.total], [11, 22, 33, 44, 110]);
  assert.equal(r.unattributed.input, 9 + 3); // l4 (after every visit) and the agent with nowhere to go
  assert.equal(Object.keys(r.nodes).length, wf.nodes.length);
  const sum = Object.values(r.nodes).reduce((a, n) => a + n.total, 0);
  assert.equal(r.total.total, sum + r.main.total + r.unattributed.total);
  assert.ok(!JSON.stringify(r).includes('9999') && !JSON.stringify(r).includes('7777') && !JSON.stringify(r).includes('6666'));
});

test('a running run closes its window at now; cost uses prices and unpriced tokens are counted separately', () => {
  const open = attributeRun({
    run: { createdAt: at('10:00:00'), endedAt: null }, workflow: wf,
    visits: [{ node: 'plan', enteredAt: at('10:00:00'), leftAt: null }],
    agents: [{ id: 'L', type: 'lead', startNodes: [], reportedNodes: [] }, { id: 'M', type: 'main', startNodes: [] }],
    messages: [
      msg('a', '10:30:00', 'L', 'S', { input: 1e6, output: 1e6 }), // opus-5: 5 + 25
      msg('b', '10:31:00', 'L', 'S', { input: 1000, model: 'mystery-1' }), // unpriced
      msg('c', '10:32:00', null, 'S', { input: 1e6 }),
    ],
    mainSessions: ['S'], prices: SEED_PRICES, now: Date.parse(at('12:00:00')),
  });
  assert.equal(open.nodes.plan.cost, 30);
  assert.equal(open.nodes.plan.unpriced, 1000);
  assert.equal(open.main.cost, 5);
  assert.equal(open.total.cost, 35);
  assert.equal(open.total.unpriced, 1000);
  assert.equal(open.total.total, 2e6 + 1000 + 1e6);
});

test('mainBySession splits the run-wide main figure by session; sessions without messages are zero', () => {
  const two = [...agents, { id: 'main:T', type: 'main', startNodes: [], reportedNodes: [] }];
  const r = go({ agents: two, mainSessions: ['S', 'T', 'Z'], messages: [...messages, msg('t1', '10:02:00', null, 'T', { input: 5, output: 1 })] });
  assert.deepEqual(Object.keys(r.mainBySession).sort(), ['S', 'T', 'Z']);
  assert.equal(r.mainBySession.S.total, 110);
  assert.equal(r.mainBySession.T.total, 6);
  assert.equal(r.mainBySession.Z.total, 0);
  assert.equal(r.main.total, 116);
});

test('pre-aggregated rows (one per agent/model, one per session/model) attribute exactly like per-message rows', () => {
  // What the SQL does: main rows are filtered to the run window first, then summed.
  const rows = messages.filter((m) => m.agentId != null || (m.sessionId === 'S' && m.ts >= run.createdAt && m.ts <= run.endedAt));
  const sums = new Map();
  for (const m of rows) {
    const lead = ['lead1', 'reporter'].includes(m.agentId);
    const k = lead ? m.id : `${m.agentId}|${m.sessionId}|${m.model}`;
    const a = sums.get(k) ?? { ...m, input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
    for (const f of ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead']) a[f] += m[f];
    sums.set(k, a);
  }
  const folded = [...sums.values()].map((m) => (m.agentId == null ? { ...m, ts: run.createdAt } : m));
  const a = go();
  const b = go({ messages: folded });
  assert.deepEqual(b.nodes, a.nodes);
  assert.deepEqual([b.main, b.unattributed, b.total], [a.main, a.unattributed, a.total]);
});
