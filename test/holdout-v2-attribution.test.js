// Holdout (phase B, AC9): src/attribution.js attributeRun on a fixture run. Pure function, no server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './holdout-v2-helpers.js';

const A = () => load('src/attribution.js');
const W = () => load('src/workflow.js');
const iso = (hm) => `2026-10-20T${hm}Z`;
const NOW = iso('10:50:00.000');

let n = 0;
const msg = (agentId, hm, o = {}) => ({
  id: `m${++n}`, ts: iso(hm), day: '2026-10-20', sessionId: o.session ?? 's1', agentId, model: o.model ?? 'claude-opus-5-5-20261001',
  input: o.input ?? 10, output: o.output ?? 2, cacheWrite: o.cacheWrite ?? 0, cacheWrite1h: o.cacheWrite1h ?? 0, cacheRead: o.cacheRead ?? 0,
});
const sum = (rows) => rows.reduce((a, r) => a + r.input + r.output + r.cacheWrite + r.cacheRead, 0);
const ag = (id, type, description, startNodes, reportedNodes) => ({ id, type, description, startNodes, reportedNodes });
const visit = (node, a, b) => ({ node, enteredAt: iso(a), leftAt: b ? iso(b) : null });

async function fixture() {
  const { attributeRun } = await A();
  const { seedWorkflow } = await W();
  const wf = seedWorkflow();
  const visits = [
    visit('plan', '10:00:00.000', '10:10:00.000'),
    visit('implement', '10:10:00.000', '10:40:00.000'),
    visit('prep', '10:10:00.000', '10:30:00.000'),
    visit('verify', '10:40:00.000', null), // still open at NOW
  ];
  const agents = [
    ag('L', 'fable-lead', 'Lead for the run', ['plan'], ['plan', 'implement', 'prep']),
    ag('W', 'general-purpose', 'build it', ['implement', 'prep'], []),
    ag('V', 'general-purpose', 'Verifier prep', ['implement', 'prep'], []),
    ag('R', 'general-purpose', 'whatever', ['verify'], ['whitehat']),
    ag('X', 'general-purpose', 'something', ['verify', 'review'], []),
    ag('Y', 'general-purpose', 'something', [], []),
  ];
  const lead = {
    plan: msg('L', '10:05:00.000', { input: 100, output: 20 }),
    parallel: msg('L', '10:15:00.000', { input: 5, output: 3, cacheWrite: 7, cacheRead: 11 }),
    boundary: msg('L', '10:10:00.000', { input: 4, output: 0 }), // enters implement and prep, leaves plan
    implOnly: msg('L', '10:35:00.000', { input: 40, output: 4 }),
    verify: msg('L', '10:45:00.000', { input: 30, output: 3 }),
    atNow: msg('L', '10:50:00.000', { input: 1000, output: 0 }), // an open visit ends before now: no window holds it
    before: msg('L', '09:00:00.000', { input: 500, output: 0 }),
  };
  const sub = {
    W: msg('W', '10:20:00.000', { input: 1000, output: 100 }),
    W2: msg('W', '10:48:00.000', { input: 1, output: 1 }),
    V: msg('V', '10:21:00.000', { input: 2000, output: 200 }),
    R: msg('R', '10:30:00.000', { input: 3000, output: 300 }),
    X: msg('X', '10:31:00.000', { input: 4000, output: 400 }),
    Y: msg('Y', '10:32:00.000', { input: 5000, output: 500 }),
  };
  const main = {
    in: msg(null, '10:20:00.000', { input: 7000, output: 70 }),
    atNow: msg(null, '10:50:00.000', { input: 8000, output: 80 }),
    early: msg(null, '09:59:59.000', { input: 9000, output: 90 }),
    late: msg(null, '10:50:01.000', { input: 9100, output: 91 }),
    otherSession: msg(null, '10:20:00.000', { input: 9200, output: 92, session: 'other' }),
  };
  const ghost = msg('ghost', '10:20:00.000', { input: 99999, output: 1 });
  const messages = [...Object.values(lead), ...Object.values(sub), ...Object.values(main), ghost];
  const out = attributeRun({ run: { createdAt: iso('10:00:00.000'), endedAt: null }, workflow: wf, visits, agents, messages, mainSessions: ['s1'], prices: [], now: NOW });
  return { out, lead, sub, main, ghost, wf };
}
const tot = (t) => t.input + t.output + t.cacheWrite + t.cacheRead;

test('AC9 result shape: nodes, main, unattributed, total and per-agent roles with Tokens', async () => {
  const { out } = await fixture();
  for (const k of ['nodes', 'main', 'unattributed', 'total', 'agents']) assert.ok(k in out, k);
  for (const t of [out.main, out.unattributed, out.total, out.nodes.plan]) {
    for (const f of ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost']) assert.equal(typeof t[f], 'number', f);
    assert.equal(t.total, t.input + t.output + t.cacheWrite + t.cacheRead, 'total is the sum of the four counts');
  }
  assert.equal(out.agents.L.role, 'lead');
  assert.equal(out.agents.W.role, 'subagent');
  assert.equal(typeof out.agents.L.tokens.total, 'number');
  assert.equal(out.agents.L.node, null, 'a lead has no single node');
});

test('AC9 main session: only agentId-null messages of a main session inside [createdAt, now] count, on the run not on a node', async () => {
  const { out, main } = await fixture();
  assert.equal(out.main.input, main.in.input + main.atNow.input, 'inclusive at now; before createdAt, after now and other sessions are out');
  assert.equal(out.main.total, tot(out.main));
  assert.equal(out.main.total, sum([main.in, main.atNow]));
  assert.equal(out.total.input >= out.main.input, true);
});

test('AC9 lead: each message goes to the visit whose window holds it; a visit window is [enteredAt, leftAt)', async () => {
  const { out, lead } = await fixture();
  assert.equal(out.nodes.plan.input, lead.plan.input, 'plan gets only its own window; the message at 10:10:00 is already implement/prep');
  assert.equal(out.nodes.plan.output, lead.plan.output);
  assert.equal(out.nodes.verify.input, lead.verify.input + 4000, 'open visit runs to now; agent X (verify) adds its 4000');
});

test('AC9 parallel visits: overlapping windows split evenly in integer shares, remainder to the first visit in visit order', async () => {
  const { out } = await fixture();
  // visit order is implement, then prep. parallel msg: input 5 -> 3/2, output 3 -> 2/1, cacheWrite 7 -> 4/3, cacheRead 11 -> 6/5; boundary msg input 4 -> 2/2.
  // implement also gets implOnly (40/4) and agent W (1000+1 / 100+1); prep also gets agent V (2000 / 200).
  assert.deepEqual([out.nodes.implement.input, out.nodes.implement.output, out.nodes.implement.cacheWrite, out.nodes.implement.cacheRead], [3 + 2 + 40 + 1001, 2 + 4 + 101, 4, 6]);
  assert.deepEqual([out.nodes.prep.input, out.nodes.prep.output, out.nodes.prep.cacheWrite, out.nodes.prep.cacheRead], [2 + 2 + 2000, 1 + 200, 3, 5]);
});

test('AC9 lead message outside every visit window (before start, or exactly at the open visit end) is unattributed', async () => {
  const { out, lead } = await fixture();
  assert.equal(out.unattributed.input, lead.before.input + lead.atNow.input + 5000, 'plus agent Y that has no start node');
});

test('AC9 subagents: single reported node, keyword match on a parallel pair, the only worker node, startNodes[0], else unattributed', async () => {
  const { out, sub } = await fixture();
  assert.equal(out.agents.R.node, 'whitehat', 'exactly one reported node wins even with no visit there');
  assert.equal(out.agents.V.node, 'prep', 'description "Verifier prep" matches the verifier runner');
  assert.equal(out.agents.W.node, 'implement', 'no keyword hit: the only worker start node');
  assert.equal(out.agents.X.node, 'verify', 'nothing matches and no worker: startNodes[0]');
  assert.equal(out.agents.Y.node, null);
  assert.equal(out.agents.R.tokens.input, sub.R.input);
  assert.equal(out.agents.W.tokens.input, sub.W.input + sub.W2.input, 'all of the agent tokens, wherever in time');
  assert.equal(out.nodes.whitehat.input, sub.R.input);
  assert.equal(out.agents.Y.tokens.input, sub.Y.input);
});

test('AC9 a lead is recognised by type /lead/i or by reporting on two or more distinct nodes', async () => {
  const { attributeRun } = await A();
  const { seedWorkflow } = await W();
  const visits = [visit('plan', '10:00:00.000', '10:10:00.000'), visit('verify', '10:10:00.000', '10:20:00.000')];
  const agents = [ag('T', 'Team-LEAD', '', ['plan'], []), ag('B', 'general-purpose', '', ['plan'], ['plan', 'verify']), ag('S', 'general-purpose', '', ['plan'], ['plan', 'plan'])];
  const messages = [msg('T', '10:05:00.000'), msg('B', '10:15:00.000'), msg('S', '10:05:00.000')];
  const out = attributeRun({ run: { createdAt: iso('10:00:00.000'), endedAt: iso('10:30:00.000') }, workflow: seedWorkflow(), visits, agents, messages, mainSessions: [], prices: [], now: NOW });
  assert.equal(out.agents.T.role, 'lead');
  assert.equal(out.agents.B.role, 'lead');
  assert.equal(out.agents.B.tokens.input, 10);
  assert.equal(out.nodes.verify.input, 10, 'B is spread over time, so its 10:15 message lands on verify');
  assert.equal(out.agents.S.role, 'subagent', 'the same node twice is one distinct node');
  assert.equal(out.agents.S.node, 'plan');
});

test('AC9 messages from agent ids that are not in the run are ignored; total = nodes + main + unattributed', async () => {
  const { out, ghost } = await fixture();
  assert.equal(JSON.stringify(out).includes('ghost'), false);
  const parts = Object.values(out.nodes).reduce((a, t) => a + t.total, 0) + out.main.total + out.unattributed.total;
  assert.equal(out.total.total, parts);
  assert.equal(out.total.input, Object.values(out.nodes).reduce((a, t) => a + t.input, 0) + out.main.input + out.unattributed.input);
  assert.ok(out.total.input < ghost.input, 'the ghost tokens are not in the total');
});

test('AC9 cost uses the price table by longest prefix, 1h cache writes at their own rate; unpriced models add 0 and are counted as unpriced', async () => {
  const { attributeRun } = await A();
  const { seedWorkflow } = await W();
  const prices = [
    { model: 'claude-opus-5', input: 5, output: 25, cacheWrite: 6.25, cacheWrite1h: 10, cacheRead: 0.5, note: '' },
    { model: 'claude-opus-5-5', input: 4, output: 20, cacheWrite: 5, cacheWrite1h: 8, cacheRead: 0.2, note: '' },
  ];
  const visits = [visit('plan', '10:00:00.000', null)];
  const agents = [ag('L', 'fable-lead', '', ['plan'], [])];
  const messages = [
    msg('L', '10:05:00.000', { input: 1e6, output: 1e5, cacheWrite: 4e5, cacheWrite1h: 1e5, cacheRead: 1e6 }),
    msg('L', '10:06:00.000', { model: 'claude-mystery-1', input: 5000, output: 500 }),
  ];
  const out = attributeRun({ run: { createdAt: iso('10:00:00.000'), endedAt: null }, workflow: seedWorkflow(), visits, agents, messages, mainSessions: [], prices, now: NOW });
  assert.ok(Math.abs(out.nodes.plan.cost - 8.5) < 1e-9, `cost ${out.nodes.plan.cost}`);
  assert.ok(Math.abs(out.total.cost - 8.5) < 1e-9);
  assert.equal(out.nodes.plan.unpriced, 5500, 'tokens with no price row');
});

test('AC9 empty inputs give zero Tokens everywhere and do not throw', async () => {
  const { attributeRun } = await A();
  const { seedWorkflow } = await W();
  const out = attributeRun({ run: { createdAt: iso('10:00:00.000'), endedAt: null }, workflow: seedWorkflow(), visits: [], agents: [], messages: [], mainSessions: [], prices: [], now: NOW });
  assert.equal(out.total.total, 0);
  assert.equal(out.main.total, 0);
  assert.equal(out.unattributed.total, 0);
  assert.deepEqual(out.agents, {});
});
