import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkflow, normalizeWorkflow } from '../src/workflow.js';
import * as engine from '../src/engine.js';

const wf = normalizeWorkflow(seedWorkflow());
const at = (stage, extra = {}) => ({ stage, round: 0, status: 'active', verdict: null, ask: null, ...extra });
const complete = (state, outcome, note, stage = state.stage) => engine.completeStage(wf, state, { stage, outcome, note });

test('start state is the first stage, active', () => {
  assert.deepEqual(engine.startState(wf), at('frame'));
});

test('a gate as first stage starts waiting with its ask', () => {
  const g = normalizeWorkflow({ ...seedWorkflow(), stages: [seedWorkflow().stages[1], ...seedWorkflow().stages.slice(2)] });
  const s = engine.startState(g);
  assert.equal(s.status, 'waiting');
  assert.equal(s.ask, "What's your solution?");
});

test('pass walks the spine, gates wait, after the last stage the run is done', () => {
  let s = engine.startState(wf);
  const seen = [s.stage];
  let guard = 0;
  while (s.status !== 'done' && guard++ < 30) {
    if (s.status === 'waiting') {
      const r = engine.respond(wf, s, { action: wf.stages.find((x) => x.id === s.stage).actions[0].label, text: '' });
      assert.ok(r.ok, r.error);
      s = r.state;
    } else {
      const r = complete(s, 'pass');
      assert.ok(r.ok, r.error);
      s = r.state;
    }
    seen.push(s.stage);
  }
  assert.deepEqual(seen, ['frame', 'gate1', 'plan', 'implement', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr', 'done']);
  assert.equal(s.status, 'done');
});

test('entering a gate waits with the gate ask; entering a step is active with no ask', () => {
  const r = complete(at('frame'), 'done');
  assert.equal(r.state.stage, 'gate1');
  assert.equal(r.state.status, 'waiting');
  assert.equal(r.state.ask, "What's your solution?");
  assert.equal(r.state.verdict, 'done');
  const r2 = engine.respond(wf, r.state, { action: 'Agree spec', text: '' });
  assert.equal(r2.state.status, 'active');
  assert.equal(r2.state.ask, null);
});

test('completing the wrong stage names the current stage', () => {
  const r = complete(at('verify'), 'pass', '', 'review');
  assert.equal(r.ok, false);
  assert.equal(r.error, "Run is at stage 'verify', not 'review'.");
});

test('complete_stage on a gate or decision says to use respond', () => {
  const gate = engine.startState(wf);
  const g = complete({ ...gate, stage: 'gate1', status: 'waiting' }, 'pass');
  assert.match(g.error, /waiting on Ryan at 'gate1'; use respond/);
  const d = complete(at('decision', { status: 'waiting', ask: 'x' }), 'pass');
  assert.match(d.error, /waiting on Ryan at 'decision'; use respond/);
});

test('done and stopped runs reject completion', () => {
  assert.match(complete(at('done', { status: 'done' }), 'pass').error, /already done/);
  assert.match(complete(at('stopped', { status: 'stopped' }), 'pass').error, /already stopped/);
});

test('unknown outcome is rejected', () => {
  assert.match(complete(at('plan'), 'banana').error, /Unknown outcome/);
});

test('fail on a checked stage with onFail fix goes to fix with round + 1', () => {
  const r = complete(at('verify'), 'fail', 'tests red');
  assert.deepEqual(r.state, at('fix', { round: 1, verdict: 'fail' }));
});

test('finding behaves like fail', () => {
  const r = complete(at('review'), 'finding', 'bad name');
  assert.equal(r.state.stage, 'fix');
  assert.equal(r.state.round, 1);
});

test('pass on fix returns to afterFix and keeps the round', () => {
  const r = complete(at('fix', { round: 2 }), 'pass');
  assert.equal(r.state.stage, 'verify');
  assert.equal(r.state.round, 2);
});

test('fail past maxRounds becomes a decision with the limit in the ask', () => {
  const r = complete(at('verify', { round: 5 }), 'fail', 'still red');
  assert.equal(r.state.stage, 'decision');
  assert.equal(r.state.status, 'waiting');
  assert.equal(r.state.ask, 'still red (fix round limit 5 reached)');
});

test('onFail decision goes straight to a decision with the note as ask', () => {
  const w = normalizeWorkflow(seedWorkflow());
  w.stages.find((s) => s.id === 'verify').check.onFail = 'decision';
  const r = engine.completeStage(w, at('verify'), { stage: 'verify', outcome: 'fail', note: 'why?' });
  assert.equal(r.state.stage, 'decision');
  assert.equal(r.state.ask, 'why?');
});

test('onFail continue moves to the next stage', () => {
  const w = normalizeWorkflow(seedWorkflow());
  w.stages.find((s) => s.id === 'review').check.onFail = 'continue';
  const r = engine.completeStage(w, at('review'), { stage: 'review', outcome: 'fail', note: '' });
  assert.equal(r.state.stage, 'whitehat');
  assert.equal(r.state.status, 'active');
});

test('fail without a check, or on fix, becomes a decision', () => {
  assert.equal(complete(at('plan'), 'fail', 'cannot plan').state.stage, 'decision');
  const r = complete(at('fix', { round: 1 }), 'fail', 'fix failed');
  assert.equal(r.state.stage, 'decision');
  assert.equal(r.state.ask, 'fix failed');
});

test('regression, env and stuck always become a decision, with a default ask', () => {
  for (const outcome of ['regression', 'env', 'stuck']) {
    for (const stage of ['implement', 'verify', 'fix']) {
      const r = complete(at(stage), outcome, 'bad');
      assert.equal(r.state.stage, 'decision', `${outcome} at ${stage}`);
      assert.equal(r.state.ask, 'bad');
    }
  }
  assert.equal(complete(at('verify'), 'env').state.ask, 'Decision needed');
});

test('respond: label match is case-insensitive and trimmed; the answer resets the round', () => {
  const waiting = at('gate2', { status: 'waiting', ask: 'x', round: 3 });
  const r = engine.respond(wf, waiting, { action: '  request CHANGES ', text: 'more tests' });
  assert.ok(r.ok);
  assert.deepEqual(r.answer, { action: 'Request changes', text: 'more tests' });
  assert.equal(r.state.stage, 'plan');
  assert.equal(r.state.round, 0);
});

test('respond: accept goes next, stop ends the run', () => {
  const waiting = at('gate2', { status: 'waiting', ask: 'x' });
  assert.equal(engine.respond(wf, waiting, { action: 'Accept' }).state.stage, 'pr');
  const s = engine.respond(wf, waiting, { action: 'Stop run' }).state;
  assert.equal(s.stage, 'stopped');
  assert.equal(s.status, 'stopped');
});

test('respond: unknown label lists the real ones; not waiting is an error', () => {
  const waiting = at('gate2', { status: 'waiting', ask: 'x' });
  assert.match(engine.respond(wf, waiting, { action: 'Maybe' }).error, /Accept, Request changes, Stop run/);
  assert.match(engine.respond(wf, at('plan'), { action: 'Accept' }).error, /not waiting/);
});

test('decision actions: Resume goes to resumeAt, Stop run stops', () => {
  const d = at('decision', { status: 'waiting', ask: 'x', round: 5 });
  const r = engine.respond(wf, d, { action: 'resume' });
  assert.equal(r.state.stage, 'plan');
  assert.equal(r.state.round, 0);
  assert.equal(engine.respond(wf, d, { action: 'Stop run' }).state.status, 'stopped');
});

test('stop() ends a run from any state', () => {
  assert.deepEqual(engine.stop(at('verify', { round: 2 })), { stage: 'stopped', round: 2, status: 'stopped', verdict: null, ask: null });
});

test('describeStage: steps, gates, fix and decision', () => {
  const plan = engine.describeStage(wf, 'plan');
  assert.equal(plan.runner, 'lead');
  assert.equal(plan.model, 'opus');
  const fix = engine.describeStage(wf, 'fix');
  assert.equal(fix.runner, 'worker');
  assert.equal(fix.model, 'sonnet');
  const gate = engine.describeStage(wf, 'gate2');
  assert.equal(gate.ask, 'Accept, push and open the PR?');
  assert.equal(gate.textField, true);
  const dec = engine.describeStage(wf, 'decision', { ask: 'pick one' });
  assert.deepEqual(dec.actions, [{ label: 'Resume' }, { label: 'Stop run' }]);
  assert.equal(dec.ask, 'pick one');
  assert.equal(dec.textField, true);
  assert.equal(engine.describeStage(wf, 'nope'), null);
});
