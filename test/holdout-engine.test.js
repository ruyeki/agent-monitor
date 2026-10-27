import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './holdout-helpers.js';

const W = await load('src/workflow.js');
const E = await load('src/engine.js');
const wf = () => structuredClone(W.seedWorkflow());
const at = (active, extra = {}) => ({ active: [].concat(active), joins: {}, round: 0, status: 'active', verdict: null, ask: null, ...extra });
const step = (w, state, outcome, note, stage) => E.completeStage(w, state, { stage: stage ?? state.active[0], outcome, note });
const edgeOf = (w, from, on) => w.edges.find((e) => e.from === from && e.on === on);
const addEdge = (w, from, to, on) => w.edges.push({ id: `${from}>${to}:${on}`, from, to, on, fixRound: false });

test('AC4 startState: start node active, round 0', () => {
  const s = E.startState(wf());
  assert.deepEqual(s.active, ['frame']);
  assert.equal(s.status, 'active');
  assert.equal(s.round, 0);
  assert.ok(!s.ask);
});

test('AC4 startState on a workflow whose start node is a gate waits with its ask', () => {
  const w = wf();
  w.nodes = w.nodes.filter((x) => x.id !== 'frame');
  w.edges = w.edges.filter((x) => x.from !== 'frame');
  const s = E.startState(w);
  assert.deepEqual(s.active, ['gate1']);
  assert.equal(s.status, 'waiting');
  assert.equal(s.ask, "What's your solution?");
});

test('AC4 pass follows the edge and enters gate1 waiting with its ask', () => {
  const r = step(wf(), at('frame'), 'pass', 'framed');
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['gate1']);
  assert.equal(r.state.status, 'waiting');
  assert.equal(r.state.ask, "What's your solution?");
  assert.equal(r.state.verdict, 'pass');
});

test('AC4 done outcome behaves like pass; entering steps is active with ask null', () => {
  const r = step(wf(), at('plan', { ask: 'stale' }), 'done');
  assert.deepEqual(r.state.active, ['implement', 'prep']);
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.ask, null);
  assert.equal(r.state.verdict, 'done');
});

test('AC4 the pushing node passes to done', () => {
  const r = step(wf(), at('pr'), 'pass');
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, []);
  assert.equal(r.state.status, 'done');
});

test('AC4 complete_stage after the run is done or stopped is rejected', () => {
  for (const st of [at([], { status: 'done' }), at([], { status: 'stopped' })]) {
    const r = step(wf(), st, 'pass', null, 'frame');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  }
});

test('AC4 a stage that is not active is refused; the error names the active ones', () => {
  const r = step(wf(), at('verify'), 'pass', null, 'plan');
  assert.equal(r.ok, false);
  assert.match(r.error, /'plan'/);
  assert.match(r.error, /verify/);
});

test('AC4 complete_stage while waiting at a gate or decision is rejected and says respond', () => {
  let r = step(wf(), at('gate1', { status: 'waiting', ask: 'x' }), 'pass');
  assert.equal(r.ok, false);
  assert.match(r.error, /waiting on Ryan at 'gate1'/);
  assert.match(r.error, /respond/);
  r = step(wf(), at('decision', { status: 'waiting', ask: 'x' }), 'pass');
  assert.equal(r.ok, false);
  assert.match(r.error, /decision/);
  assert.match(r.error, /respond/);
});

test('AC4 unknown outcome is an error', () => {
  for (const o of ['maybe', '', undefined, 'PASS ']) {
    const r = step(wf(), at('frame'), o);
    assert.equal(r.ok, false, String(o));
  }
});

test('AC4 fail at round 0 goes to fix round 1', () => {
  const r = step(wf(), at('verify'), 'fail', 'tests red');
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['fix']);
  assert.equal(r.state.round, 1);
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.verdict, 'fail');
});

test('AC4 finding behaves like fail on a check', () => {
  const r = step(wf(), at('review'), 'finding', 'bug');
  assert.deepEqual(r.state.active, ['fix']);
  assert.equal(r.state.round, 1);
});

test('AC4 round boundary: maxRounds-1 -> fix (round = max); maxRounds -> decision with limit note', () => {
  let r = step(wf(), at('verify', { round: 4 }), 'fail', 'still red');
  assert.deepEqual(r.state.active, ['fix']);
  assert.equal(r.state.round, 5);
  r = step(wf(), at('verify', { round: 5 }), 'fail', 'still red');
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['decision']);
  assert.equal(r.state.status, 'waiting');
  assert.ok(r.state.ask.includes('still red'));
  assert.ok(r.state.ask.includes('(fix round limit 5 reached)'), r.state.ask);
});

test('AC4 round boundary follows a custom maxRounds (1 and 10)', () => {
  const w1 = wf(); w1.loop.maxRounds = 1;
  assert.deepEqual(step(w1, at('verify', { round: 0 }), 'fail', 'n').state.active, ['fix']);
  const d = step(w1, at('verify', { round: 1 }), 'fail', 'n');
  assert.deepEqual(d.state.active, ['decision']);
  assert.ok(d.state.ask.includes('(fix round limit 1 reached)'));
  const w10 = wf(); w10.loop.maxRounds = 10;
  assert.equal(step(w10, at('whitehat', { round: 9 }), 'fail', 'n').state.round, 10);
  assert.deepEqual(step(w10, at('whitehat', { round: 10 }), 'fail', 'n').state.active, ['decision']);
});

test('AC4 fix done follows its edge back, keeping the round', () => {
  for (const o of ['pass', 'done']) {
    const r = step(wf(), at('fix', { round: 3 }), o);
    assert.equal(r.ok, true);
    assert.deepEqual(r.state.active, ['verify']);
    assert.equal(r.state.round, 3);
    assert.equal(r.state.status, 'active');
  }
  const w = wf(); edgeOf(w, 'fix', 'done').to = 'review';
  assert.deepEqual(step(w, at('fix', { round: 2 }), 'done').state.active, ['review']);
});

test('AC4 fail with no fail edge is refused; with an edge to the decision it asks the note', () => {
  let r = step(wf(), at('fix', { round: 2 }), 'fail', 'could not fix');
  assert.equal(r.ok, false);
  assert.match(r.error, /Valid outcomes: pass, done/);
  assert.equal(step(wf(), at('plan'), 'finding', 'x').ok, false);
  const w = wf(); addEdge(w, 'fix', 'decision', 'fail');
  r = step(w, at('fix', { round: 2 }), 'fail', 'could not fix');
  assert.deepEqual(r.state.active, ['decision']);
  assert.equal(r.state.status, 'waiting');
  assert.ok(r.state.ask.includes('could not fix'));
});

test('AC4 regression/env/stuck go where their edge goes; no edge means refused', () => {
  for (const o of ['regression', 'env', 'stuck']) {
    const r = step(wf(), at('verify'), o, `note for ${o}`);
    assert.equal(r.ok, true, o);
    assert.deepEqual(r.state.active, ['decision']);
    assert.equal(r.state.status, 'waiting');
    assert.equal(r.state.ask, `note for ${o}`);
    assert.equal(r.state.verdict, o);
    for (const from of ['implement', 'review', 'plan', 'fix']) {
      const no = step(wf(), at(from), o, 'x');
      assert.equal(no.ok, false, `${o} from ${from}`);
      assert.match(no.error, /Valid outcomes: /);
    }
  }
});

test('AC4 regression with no note still asks something', () => {
  const r = step(wf(), at('verify'), 'regression');
  assert.deepEqual(r.state.active, ['decision']);
  assert.ok(r.state.ask && r.state.ask.length > 0);
});

test('AC4 a fail edge may go straight to the decision or on to the next node', () => {
  const w = wf(); Object.assign(edgeOf(w, 'verify', 'fail'), { to: 'decision', fixRound: false });
  const d = step(w, at('verify'), 'fail', 'nope');
  assert.deepEqual(d.state.active, ['decision']);
  assert.equal(d.state.ask, 'nope');
  const w2 = wf(); Object.assign(edgeOf(w2, 'verify', 'fail'), { to: 'review', fixRound: false });
  const c = step(w2, at('verify'), 'fail', 'meh');
  assert.deepEqual(c.state.active, ['review']);
  assert.equal(c.state.status, 'active');
});

test('AC4 completeStage is pure: input state and workflow unchanged', () => {
  const w = wf(); const copyW = structuredClone(w);
  const s = at('verify', { round: 2 }); const copyS = structuredClone(s);
  step(w, s, 'fail', 'x');
  assert.deepEqual(s, copyS);
  assert.deepEqual(w, copyW);
});

test('AC4 respond gate1: Agree spec -> plan, round reset, answer returned', () => {
  const r = E.respond(wf(), at('gate1', { status: 'waiting', round: 3, ask: 'x' }), { action: 'Agree spec', text: 'use X' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['plan']);
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.round, 0);
  assert.equal(r.state.ask, null);
  assert.equal(r.answer.text, 'use X');
  assert.match(r.answer.action, /agree spec/i);
});

test('AC4 respond label match is case-insensitive and trimmed', () => {
  const r = E.respond(wf(), at('gate1', { status: 'waiting' }), { action: '  aGrEe SPEC ', text: '' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['plan']);
});

test('AC4 respond follows the action edge: next node, an earlier node, or stopped', () => {
  const g2 = at('gate2', { status: 'waiting' });
  assert.deepEqual(E.respond(wf(), g2, { action: 'Accept' }).state.active, ['pr']);
  const back = E.respond(wf(), at('gate2', { status: 'waiting', round: 2 }), { action: 'Request changes', text: 'redo' });
  assert.deepEqual(back.state.active, ['plan']);
  assert.equal(back.state.status, 'active');
  assert.equal(back.state.round, 0);
  const stop = E.respond(wf(), g2, { action: 'Stop run' });
  assert.deepEqual(stop.state.active, []);
  assert.equal(stop.state.status, 'stopped');
  const w = wf(); edgeOf(w, 'gate1', 'Agree spec').to = 'review';
  assert.deepEqual(E.respond(w, at('gate1', { status: 'waiting' }), { action: 'Agree spec' }).state.active, ['review']);
});

test('AC4 respond with unknown action lists the labels', () => {
  const r = E.respond(wf(), at('gate2', { status: 'waiting' }), { action: 'Explode' });
  assert.equal(r.ok, false);
  for (const l of ['Accept', 'Request changes', 'Stop run']) assert.ok(r.error.includes(l), r.error);
});

test('AC4 respond when not waiting is rejected', () => {
  assert.equal(E.respond(wf(), at('plan'), { action: 'Accept' }).ok, false);
  assert.equal(E.respond(wf(), at([], { status: 'done' }), { action: 'Accept' }).ok, false);
  assert.equal(E.respond(wf(), at([], { status: 'stopped' }), { action: 'Stop run' }).ok, false);
});

test('AC4 decision: Resume -> plan with round 0; Stop run -> stopped', () => {
  const dec = at('decision', { status: 'waiting', round: 5, ask: 'why' });
  const r = E.respond(wf(), dec, { action: 'Resume', text: 'try again' });
  assert.equal(r.ok, true);
  assert.deepEqual(r.state.active, ['plan']);
  assert.equal(r.state.round, 0);
  assert.equal(r.state.status, 'active');
  assert.equal(r.answer.text, 'try again');
  const w = wf(); edgeOf(w, 'decision', 'Resume').to = 'verify';
  assert.deepEqual(E.respond(w, dec, { action: 'resume' }).state.active, ['verify']);
  const s = E.respond(wf(), dec, { action: 'Stop run' });
  assert.deepEqual(s.state.active, []);
  assert.equal(s.state.status, 'stopped');
  assert.equal(E.respond(wf(), dec, { action: 'Accept' }).ok, false);
});

test('AC4 respond is pure', () => {
  const s = at('gate1', { status: 'waiting', ask: 'q' }); const c = structuredClone(s);
  E.respond(wf(), s, { action: 'Agree spec' });
  assert.deepEqual(s, c);
});

test('AC4 stop()', () => {
  const s = E.stop(at(['implement', 'prep'], { round: 2 }));
  assert.deepEqual(s.active, []);
  assert.equal(s.status, 'stopped');
});

test('AC4 describeNode for step, gate, fix, decision', () => {
  const w = wf();
  const plan = E.describeNode(w, 'plan', at('plan'));
  assert.equal(plan.id, 'plan'); assert.equal(plan.type, 'step');
  assert.equal(plan.runner, 'lead'); assert.equal(plan.model, 'opus');
  assert.ok(plan.instructions);
  const g = E.describeNode(w, 'gate2', at('gate2', { status: 'waiting' }));
  assert.equal(g.type, 'gate');
  assert.equal(g.ask, 'Accept, push and open the PR?');
  assert.deepEqual(g.actions.map((a) => a.label), ['Accept', 'Request changes', 'Stop run']);
  assert.equal(g.textField, true);
  const fix = E.describeNode(w, 'fix', at('fix', { round: 1 }));
  assert.equal(fix.runner, 'worker');
  assert.equal(fix.model, 'sonnet');
  const w2 = wf(); Object.assign(w2.nodes.find((x) => x.id === 'fix'), { runner: 'custom', model: 'haiku' });
  const fix2 = E.describeNode(w2, 'fix', at('fix'));
  assert.equal(fix2.runner, 'custom');
  assert.equal(fix2.model, 'haiku');
  const d = E.describeNode(w, 'decision', at('decision', { status: 'waiting', ask: 'q' }));
  assert.deepEqual(d.actions.map((a) => a.label), ['Resume', 'Stop run']);
  assert.equal(d.ask, 'q');
  assert.equal(d.textField, true);
});
