import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './holdout-helpers.js';

const W = await load('src/workflow.js');
const E = await load('src/engine.js');
const wf = () => structuredClone(W.seedWorkflow());
const at = (stage, extra = {}) => ({ stage, round: 0, status: 'active', verdict: null, ask: null, ...extra });
const step = (w, state, outcome, note, stage) => E.completeStage(w, state, { stage: stage ?? state.stage, outcome, note });

test('AC4 startState: first stage, active, round 0', () => {
  const s = E.startState(wf());
  assert.equal(s.stage, 'frame');
  assert.equal(s.status, 'active');
  assert.equal(s.round, 0);
  assert.ok(!s.ask);
});

test('AC4 startState on a workflow whose first stage is a gate waits with its ask', () => {
  const w = wf(); w.stages = [w.stages[1], ...w.stages.filter((x) => x.id !== 'gate1')];
  const s = E.startState(w);
  assert.equal(s.stage, 'gate1');
  assert.equal(s.status, 'waiting');
  assert.equal(s.ask, "What's your solution?");
});

test('AC4 pass walks the spine and enters gate1 waiting with its ask', () => {
  const r = step(wf(), at('frame'), 'pass', 'framed');
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'gate1');
  assert.equal(r.state.status, 'waiting');
  assert.equal(r.state.ask, "What's your solution?");
  assert.equal(r.state.verdict, 'pass');
});

test('AC4 done outcome behaves like pass; entering a step is active with ask null', () => {
  const r = step(wf(), at('plan', { ask: 'stale' }), 'done');
  assert.equal(r.state.stage, 'implement');
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.ask, null);
  assert.equal(r.state.verdict, 'done');
});

test('AC4 last spine stage passes to done', () => {
  const r = step(wf(), at('pr'), 'pass');
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'done');
  assert.equal(r.state.status, 'done');
});

test('AC4 complete_stage after the run is done or stopped is rejected', () => {
  for (const st of [at('done', { status: 'done' }), at('stopped', { status: 'stopped' })]) {
    const r = step(wf(), st, 'pass', null, 'frame');
    assert.equal(r.ok, false);
    assert.ok(r.error);
  }
});

test('AC4 wrong stage error names the current stage', () => {
  const r = step(wf(), at('verify'), 'pass', null, 'plan');
  assert.equal(r.ok, false);
  assert.match(r.error, /'verify'/);
  assert.match(r.error, /'plan'/);
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
  assert.equal(r.state.stage, 'fix');
  assert.equal(r.state.round, 1);
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.verdict, 'fail');
});

test('AC4 finding behaves like fail on a check stage', () => {
  const r = step(wf(), at('review'), 'finding', 'bug');
  assert.equal(r.state.stage, 'fix');
  assert.equal(r.state.round, 1);
});

test('AC4 round boundary: maxRounds-1 -> fix (round = max); maxRounds -> decision with limit note', () => {
  let r = step(wf(), at('verify', { round: 4 }), 'fail', 'still red');
  assert.equal(r.state.stage, 'fix');
  assert.equal(r.state.round, 5);
  r = step(wf(), at('verify', { round: 5 }), 'fail', 'still red');
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'decision');
  assert.equal(r.state.status, 'waiting');
  assert.ok(r.state.ask.includes('still red'));
  assert.ok(r.state.ask.includes('(fix round limit 5 reached)'), r.state.ask);
});

test('AC4 round boundary follows a custom maxRounds (1 and 10)', () => {
  const w1 = wf(); w1.loop.maxRounds = 1;
  assert.equal(step(w1, at('verify', { round: 0 }), 'fail', 'n').state.stage, 'fix');
  const d = step(w1, at('verify', { round: 1 }), 'fail', 'n');
  assert.equal(d.state.stage, 'decision');
  assert.ok(d.state.ask.includes('(fix round limit 1 reached)'));
  const w10 = wf(); w10.loop.maxRounds = 10;
  assert.equal(step(w10, at('whitehat', { round: 9 }), 'fail', 'n').state.round, 10);
  assert.equal(step(w10, at('whitehat', { round: 10 }), 'fail', 'n').state.stage, 'decision');
});

test('AC4 fix done goes to afterFix keeping the round', () => {
  for (const o of ['pass', 'done']) {
    const r = step(wf(), at('fix', { round: 3 }), o);
    assert.equal(r.ok, true);
    assert.equal(r.state.stage, 'verify');
    assert.equal(r.state.round, 3);
    assert.equal(r.state.status, 'active');
  }
  const w = wf(); w.loop.afterFix = 'review';
  assert.equal(step(w, at('fix', { round: 2 }), 'done').state.stage, 'review');
});

test('AC4 fail on fix goes to decision; fail on a step without a check goes to decision', () => {
  let r = step(wf(), at('fix', { round: 2 }), 'fail', 'could not fix');
  assert.equal(r.state.stage, 'decision');
  assert.equal(r.state.status, 'waiting');
  assert.ok(r.state.ask.includes('could not fix'));
  r = step(wf(), at('implement'), 'fail', 'cannot build');
  assert.equal(r.state.stage, 'decision');
  assert.ok(r.state.ask.includes('cannot build'));
  r = step(wf(), at('plan'), 'finding', 'x');
  assert.equal(r.state.stage, 'decision');
});

test('AC4 regression/env/stuck go to decision from any step including fix; note is the ask', () => {
  for (const o of ['regression', 'env', 'stuck']) {
    for (const from of ['implement', 'verify', 'review', 'plan']) {
      const r = step(wf(), at(from), o, `note for ${o}`);
      assert.equal(r.ok, true, `${o} from ${from}`);
      assert.equal(r.state.stage, 'decision');
      assert.equal(r.state.status, 'waiting');
      assert.equal(r.state.ask, `note for ${o}`);
      assert.equal(r.state.verdict, o);
    }
    const f = step(wf(), at('fix', { round: 2 }), o, 'x');
    assert.equal(f.state.stage, 'decision');
  }
});

test('AC4 regression with no note still asks something', () => {
  const r = step(wf(), at('verify'), 'regression');
  assert.equal(r.state.stage, 'decision');
  assert.ok(r.state.ask && r.state.ask.length > 0);
});

test('AC4 onFail decision and onFail continue', () => {
  const w = wf(); w.stages.find((s) => s.id === 'verify').check.onFail = 'decision';
  const d = step(w, at('verify'), 'fail', 'nope');
  assert.equal(d.state.stage, 'decision');
  assert.equal(d.state.ask, 'nope');
  const w2 = wf(); w2.stages.find((s) => s.id === 'verify').check.onFail = 'continue';
  const c = step(w2, at('verify'), 'fail', 'meh');
  assert.equal(c.state.stage, 'review');
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
  assert.equal(r.state.stage, 'plan');
  assert.equal(r.state.status, 'active');
  assert.equal(r.state.round, 0);
  assert.equal(r.state.ask, null);
  assert.equal(r.answer.text, 'use X');
  assert.match(r.answer.action, /agree spec/i);
});

test('AC4 respond label match is case-insensitive and trimmed', () => {
  const r = E.respond(wf(), at('gate1', { status: 'waiting' }), { action: '  aGrEe SPEC ', text: '' });
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'plan');
});

test('AC4 respond gate goto next / stage id / stop', () => {
  const g2 = at('gate2', { status: 'waiting' });
  assert.equal(E.respond(wf(), g2, { action: 'Accept' }).state.stage, 'pr');
  const back = E.respond(wf(), at('gate2', { status: 'waiting', round: 2 }), { action: 'Request changes', text: 'redo' });
  assert.equal(back.state.stage, 'plan');
  assert.equal(back.state.status, 'active');
  assert.equal(back.state.round, 0);
  const stop = E.respond(wf(), g2, { action: 'Stop run' });
  assert.equal(stop.state.stage, 'stopped');
  assert.equal(stop.state.status, 'stopped');
  const w = wf(); w.stages.find((s) => s.id === 'gate1').actions[0].goto = 'implement';
  assert.equal(E.respond(w, at('gate1', { status: 'waiting' }), { action: 'Agree spec' }).state.stage, 'implement');
});

test('AC4 respond with unknown action lists the labels', () => {
  const r = E.respond(wf(), at('gate2', { status: 'waiting' }), { action: 'Explode' });
  assert.equal(r.ok, false);
  for (const l of ['Accept', 'Request changes', 'Stop run']) assert.ok(r.error.includes(l), r.error);
});

test('AC4 respond when not waiting is rejected', () => {
  assert.equal(E.respond(wf(), at('plan'), { action: 'Accept' }).ok, false);
  assert.equal(E.respond(wf(), at('done', { status: 'done' }), { action: 'Accept' }).ok, false);
  assert.equal(E.respond(wf(), at('stopped', { status: 'stopped' }), { action: 'Stop run' }).ok, false);
});

test('AC4 decision: Resume -> resumeAt with round 0; Stop run -> stopped', () => {
  const dec = at('decision', { status: 'waiting', round: 5, ask: 'why' });
  const r = E.respond(wf(), dec, { action: 'Resume', text: 'try again' });
  assert.equal(r.ok, true);
  assert.equal(r.state.stage, 'plan');
  assert.equal(r.state.round, 0);
  assert.equal(r.state.status, 'active');
  assert.equal(r.answer.text, 'try again');
  const w = wf(); w.loop.resumeAt = 'implement';
  assert.equal(E.respond(w, dec, { action: 'resume' }).state.stage, 'implement');
  const s = E.respond(wf(), dec, { action: 'Stop run' });
  assert.equal(s.state.stage, 'stopped');
  assert.equal(s.state.status, 'stopped');
  assert.equal(E.respond(wf(), dec, { action: 'Accept' }).ok, false);
});

test('AC4 respond is pure', () => {
  const s = at('gate1', { status: 'waiting', ask: 'q' }); const c = structuredClone(s);
  E.respond(wf(), s, { action: 'Agree spec' });
  assert.deepEqual(s, c);
});

test('AC4 stop()', () => {
  const s = E.stop(at('verify', { round: 2 }));
  assert.equal(s.stage, 'stopped');
  assert.equal(s.status, 'stopped');
});

test('AC4 describeStage for step, gate, fix, decision', () => {
  const w = wf();
  const plan = E.describeStage(w, 'plan', at('plan'));
  assert.equal(plan.id, 'plan'); assert.equal(plan.kind, 'step');
  assert.equal(plan.runner, 'lead'); assert.equal(plan.model, 'opus');
  assert.ok(plan.instructions);
  const g = E.describeStage(w, 'gate2', at('gate2', { status: 'waiting' }));
  assert.equal(g.kind, 'gate');
  assert.equal(g.ask, 'Accept, push and open the PR?');
  assert.deepEqual(g.actions.map((a) => a.label), ['Accept', 'Request changes', 'Stop run']);
  assert.equal(g.textField, true);
  const fix = E.describeStage(w, 'fix', at('fix', { round: 1 }));
  assert.equal(fix.runner, 'worker');
  assert.equal(fix.model, 'sonnet');
  const w2 = wf(); w2.loop.fixRunner = 'opus-ish'; w2.loop.fixModel = 'haiku';
  const fix2 = E.describeStage(w2, 'fix', at('fix'));
  assert.equal(fix2.runner, 'opus-ish');
  assert.equal(fix2.model, 'haiku');
  const d = E.describeStage(w, 'decision', at('decision', { status: 'waiting', ask: 'q' }));
  assert.deepEqual(d.actions.map((a) => a.label), ['Resume', 'Stop run']);
  assert.equal(d.textField, true);
});
