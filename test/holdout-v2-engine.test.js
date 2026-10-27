// Holdout: AC4 (pure engine rules) on the seed graph and on small custom graphs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, clone } from './holdout-v2-helpers.js';

const E = () => load('src/engine.js');
const W = () => load('src/workflow.js');

const node = (id, type = 'step', extra = {}) => ({
  id, type, name: `Node ${id}`, runner: 'worker', model: 'inherit', instructions: 'do it', position: { x: 0, y: 0 }, ...extra,
});
const gate = (id, labels, extra = {}) => node(id, 'gate', { runner: 'main', ask: `ask ${id}`, actions: labels.map((label) => ({ label })), textField: true, ...extra });
let n = 0;
const edge = (from, to, on, extra = {}) => ({ id: `x${++n}`, from, to, on, ...extra });
const wf = (nodes, edges, loop = {}) => ({ nodes, edges, loop: { maxRounds: 5, decision: 'decision', ...loop } });

async function ctx() {
  const [engine, wfm] = await Promise.all([E(), W()]);
  const w = wfm.seedWorkflow();
  const run = { state: engine.startState(w), log: [] };
  const done = (stage, outcome = 'done', note) => {
    const r = engine.completeStage(w, run.state, { stage, outcome, note });
    assert.equal(r.ok, true, `${stage} ${outcome}: ${r.error}`);
    run.state = r.state; run.log.push(r);
    return r;
  };
  const answer = (action, text = '') => {
    const r = engine.respond(w, run.state, { action, text });
    assert.equal(r.ok, true, `${action}: ${r.error}`);
    run.state = r.state; run.log.push(r);
    return r;
  };
  // frame -> gate1 -> plan -> split: the state is then at the parallel pair
  const toSplit = () => { done('frame'); answer('Agree spec', 'spec'); done('plan'); };
  const toVerify = () => { toSplit(); done('implement'); done('prep'); };
  return { engine, w, run, done, answer, toSplit, toVerify, get s() { return run.state; } };
}
const sorted = (a) => [...a].sort();

test('exports', async () => {
  const e = await E();
  for (const k of ['startState', 'completeStage', 'respond', 'stop', 'describeNode', 'validOutcomes']) assert.equal(typeof e[k], 'function', k);
});

test('startState: only the start node is active', async () => {
  const c = await ctx();
  assert.deepEqual(c.s.active, ['frame']);
  assert.deepEqual(c.s.joins, {});
  assert.equal(c.s.round, 0);
  assert.equal(c.s.status, 'active');
});

test('a step reports done: the next node is entered, entered/left are listed', async () => {
  const c = await ctx();
  const r = c.done('frame');
  assert.deepEqual(r.entered, ['gate1']);
  assert.deepEqual(r.left, ['frame']);
  assert.deepEqual(c.s.active, ['gate1']);
  assert.equal(c.s.status, 'waiting');
  assert.equal(c.s.ask, "What's your solution?");
});

test('pass is an alias of done for a step edge', async () => {
  const c = await ctx();
  c.done('frame', 'pass');
  assert.deepEqual(c.s.active, ['gate1']);
});

test('completeStage errors: unknown outcome, inactive stage, gate, missing edge', async () => {
  const c = await ctx();
  const { engine, w } = c;
  assert.match(engine.completeStage(w, c.s, { stage: 'frame', outcome: 'meh' }).error, /outcome/i);
  assert.equal(engine.completeStage(w, c.s, { stage: 'verify', outcome: 'pass' }).error, "Stage 'verify' is not active. Active: frame.");
  assert.equal(engine.completeStage(w, c.s, { stage: 'nonexistent', outcome: 'pass' }).ok, false);
  const noEdge = engine.completeStage(w, c.s, { stage: 'frame', outcome: 'fail' });
  assert.equal(noEdge.ok, false);
  assert.match(noEdge.error, /^No edge from 'frame' for outcome 'fail'\. Valid outcomes: .*(done|pass)/);
  c.done('frame');
  assert.equal(engine.completeStage(w, c.s, { stage: 'gate1', outcome: 'pass' }).error, "Run is waiting on Ryan at 'gate1'; use respond.");
});

test('completeStage errors do not change the state', async () => {
  const c = await ctx();
  const before = clone(c.s);
  c.engine.completeStage(c.w, c.s, { stage: 'verify', outcome: 'pass' });
  c.engine.completeStage(c.w, c.s, { stage: 'frame', outcome: 'fail' });
  assert.deepEqual(c.s, before);
});

test('a gate answers by label: trimmed, case-insensitive; unknown label lists the choices', async () => {
  const c = await ctx();
  c.done('frame');
  const bad = c.engine.respond(c.w, c.s, { action: 'maybe' });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Agree spec/);
  assert.match(bad.error, /Stop run/);
  const r = c.answer('  aGrEe SPEC ', 'my text');
  assert.deepEqual(r.answer, { action: 'Agree spec', text: 'my text' });
  assert.deepEqual(c.s.active, ['plan']);
  assert.equal(c.s.status, 'active');
  assert.deepEqual(r.left, ['gate1']);
  assert.deepEqual(r.entered, ['plan']);
});

test('respond is refused when nothing is waiting', async () => {
  const c = await ctx();
  const r = c.engine.respond(c.w, c.s, { action: 'Agree spec' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not waiting|waiting/i);
});

test('Stop run at a gate ends the run as stopped', async () => {
  const c = await ctx();
  c.done('frame');
  c.answer('Stop run');
  assert.equal(c.s.status, 'stopped');
  assert.deepEqual(c.s.active, []);
  assert.equal(c.engine.completeStage(c.w, c.s, { stage: 'frame', outcome: 'done' }).error, 'Run is already stopped.');
  assert.equal(c.engine.respond(c.w, c.s, { action: 'x' }).ok, false);
});

test('split activates every target; the join waits for the last branch', async () => {
  const c = await ctx();
  c.done('frame'); c.answer('Agree spec');
  const r = c.done('plan');
  assert.deepEqual(sorted(c.s.active), ['implement', 'prep']);
  assert.deepEqual(sorted(r.entered), ['implement', 'prep']);
  assert.deepEqual(r.left, ['plan']);
  assert.equal(c.s.status, 'active');
  const first = c.done('implement', 'pass');
  assert.deepEqual(c.s.active, ['prep']);
  assert.deepEqual(first.left, ['implement']);
  assert.deepEqual(first.entered, [], 'a join is transient: it is not listed');
  assert.equal(Object.keys(c.s.joins).length, 1);
  assert.equal(Object.values(c.s.joins)[0].length, 1);
  const last = c.done('prep');
  assert.deepEqual(c.s.active, ['verify']);
  assert.deepEqual(c.s.joins, {}, 'join state is cleared once it fires');
  assert.deepEqual(last.entered, ['verify']);
  assert.deepEqual(last.left, ['prep']);
});

test('branches may finish in either order', async () => {
  const c = await ctx();
  c.toSplit();
  c.done('prep');
  assert.deepEqual(c.s.active, ['implement']);
  c.done('implement');
  assert.deepEqual(c.s.active, ['verify']);
});

test('reporting a branch that already finished, or a node that is not active, is refused', async () => {
  const c = await ctx();
  c.toSplit();
  c.done('implement');
  const again = c.engine.completeStage(c.w, c.s, { stage: 'implement', outcome: 'done' });
  assert.equal(again.ok, false);
  assert.match(again.error, /Stage 'implement' is not active\. Active: prep\./);
  const other = c.engine.completeStage(c.w, c.s, { stage: 'verify', outcome: 'pass' });
  assert.match(other.error, /not active/);
});

test('an escalation with no edge and no * is refused with the valid outcomes', async () => {
  const c = await ctx();
  c.toSplit();
  const r = c.engine.completeStage(c.w, c.s, { stage: 'implement', outcome: 'stuck' });
  assert.equal(r.ok, false);
  assert.match(r.error, /^No edge from 'implement' for outcome 'stuck'\. Valid outcomes: /);
});

test('verify fail -> fix with round+1; fix done -> verify; verdict follows the outcome', async () => {
  const c = await ctx();
  c.toVerify();
  const r = c.done('verify', 'fail', 'tests red');
  assert.deepEqual(c.s.active, ['fix']);
  assert.equal(c.s.round, 1);
  assert.equal(c.s.verdict, 'fail');
  assert.deepEqual(r.left, ['verify']);
  assert.deepEqual(r.entered, ['fix']);
  c.done('fix');
  assert.deepEqual(c.s.active, ['verify']);
  assert.equal(c.s.round, 1, 'a finished fix keeps the round');
  c.done('verify', 'pass');
  assert.deepEqual(c.s.active, ['review']);
  assert.equal(c.s.round, 1, 'passing does not reset the round');
});

test('finding is an alias of fail on a check', async () => {
  const c = await ctx();
  c.toVerify();
  c.done('verify', 'finding');
  assert.deepEqual(c.s.active, ['fix']);
  assert.equal(c.s.round, 1);
});

test('review finding and whitehat finding go to fix with round+1; passes continue', async () => {
  const c = await ctx();
  c.toVerify();
  c.done('verify', 'pass');
  c.done('review', 'finding');
  assert.deepEqual(c.s.active, ['fix']);
  assert.equal(c.s.round, 1);
  c.done('fix'); c.done('verify', 'pass'); c.done('review', 'pass');
  assert.deepEqual(c.s.active, ['whitehat']);
  c.done('whitehat', 'finding');
  assert.deepEqual(c.s.active, ['fix']);
  assert.equal(c.s.round, 2);
  c.done('fix'); c.done('verify'); c.done('review'); c.done('whitehat', 'pass');
  assert.deepEqual(c.s.active, ['commit']);
});

test('the round limit routes to decision with the note, then Resume resets the round', async () => {
  const c = await ctx();
  c.toVerify();
  for (let i = 1; i <= 5; i++) {
    c.done('verify', 'fail', `red ${i}`);
    assert.deepEqual(c.s.active, ['fix'], `round ${i}`);
    assert.equal(c.s.round, i);
    c.done('fix');
  }
  const r = c.done('verify', 'fail', 'still red');
  assert.deepEqual(c.s.active, ['decision']);
  assert.equal(c.s.status, 'waiting');
  assert.equal(c.s.ask, 'still red (fix round limit 5 reached)');
  assert.deepEqual(r.left, ['verify']);
  assert.deepEqual(r.entered, ['decision']);
  const a = c.answer('Resume');
  assert.equal(c.s.round, 0, 'a decision answer resets the round');
  assert.deepEqual(c.s.active, ['plan']);
  assert.equal(a.answer.action, 'Resume');
});

test('the round-limit ask has a default note', async () => {
  const c = await ctx();
  c.toVerify();
  for (let i = 0; i < 5; i++) { c.done('verify', 'fail'); c.done('fix'); }
  c.done('verify', 'fail');
  assert.equal(c.s.ask, 'Checks failed (fix round limit 5 reached)');
});

test('maxRounds comes from the workflow', async () => {
  const c = await ctx();
  c.w.loop.maxRounds = 1;
  c.toVerify();
  c.done('verify', 'fail'); c.done('fix');
  c.done('verify', 'fail', 'again');
  assert.deepEqual(c.s.active, ['decision']);
  assert.equal(c.s.ask, 'again (fix round limit 1 reached)');
});

test('regression, env and stuck on verify go to decision; the ask is the note or the node ask', async () => {
  for (const outcome of ['regression', 'env', 'stuck']) {
    const c = await ctx();
    c.toVerify();
    c.done('verify', outcome, 'broke it');
    assert.deepEqual(c.s.active, ['decision'], outcome);
    assert.equal(c.s.status, 'waiting');
    assert.equal(c.s.ask, 'broke it');
    assert.equal(c.s.verdict, outcome);
    const d = await ctx();
    d.toVerify();
    d.done('verify', outcome);
    assert.equal(d.s.ask, 'Decision needed');
  }
});

test('decision Stop run stops the run; decision answers reset the round', async () => {
  const c = await ctx();
  c.toVerify();
  c.done('verify', 'fail'); c.done('fix'); c.done('verify', 'fail');
  assert.equal(c.s.round, 2);
  c.done('fix'); c.done('verify', 'stuck');
  c.answer('Stop run');
  assert.equal(c.s.status, 'stopped');
  assert.equal(c.s.round, 0);
  assert.deepEqual(c.s.active, []);
});

test('gate2: Accept -> pr -> done; Request changes -> plan with round 0; Stop run', async () => {
  const c = await ctx();
  c.toVerify();
  c.done('verify', 'fail'); c.done('fix'); c.done('verify');
  c.done('review'); c.done('whitehat'); c.done('commit'); c.done('report');
  assert.deepEqual(c.s.active, ['gate2']);
  assert.equal(c.s.ask, 'Accept, push and open the PR?');
  assert.equal(c.s.round, 1);
  const back = await ctx();
  back.toVerify(); back.done('verify'); back.done('review'); back.done('whitehat'); back.done('commit'); back.done('report');
  back.answer('Request changes', 'more');
  assert.deepEqual(back.s.active, ['plan']);
  c.answer('Accept');
  assert.equal(c.s.round, 0, 'every answer resets the round');
  assert.deepEqual(c.s.active, ['pr']);
  const end = c.done('pr');
  assert.equal(c.s.status, 'done');
  assert.deepEqual(c.s.active, []);
  assert.deepEqual(end.entered, ['done']);
  assert.deepEqual(end.left, ['pr']);
  assert.equal(c.engine.completeStage(c.w, c.s, { stage: 'pr', outcome: 'done' }).error, 'Run is already done.');
});

test('describeNode: steps, checks and gates', async () => {
  const c = await ctx();
  const d = c.engine.describeNode(c.w, 'verify', c.s);
  assert.deepEqual(Object.keys(d).sort(), ['id', 'instructions', 'model', 'name', 'runner', 'type']);
  assert.equal(d.type, 'check');
  assert.equal(d.runner, 'verifier');
  const g = c.engine.describeNode(c.w, 'gate2', c.s);
  assert.equal(g.type, 'gate');
  assert.equal(g.ask, 'Accept, push and open the PR?');
  assert.deepEqual(g.actions.map((a) => a.label), ['Accept', 'Request changes', 'Stop run']);
  assert.equal(g.textField, true);
  assert.equal(c.engine.describeNode(c.w, 'does-not-exist', c.s) ?? null, null);
});

test('describeNode: the active decision gate shows the state ask', async () => {
  const c = await ctx();
  c.toVerify();
  c.done('verify', 'stuck', 'cannot reach db');
  assert.equal(c.engine.describeNode(c.w, 'decision', c.s).ask, 'cannot reach db');
  assert.equal(c.engine.describeNode(c.w, 'gate2', c.s).ask, 'Accept, push and open the PR?');
});

test('validOutcomes: a step offers success, a check success and failure', async () => {
  const c = await ctx();
  const step = c.engine.validOutcomes(c.w, 'frame');
  assert.ok(step.includes('done') || step.includes('pass'));
  assert.ok(!step.includes('fail'));
  const check = c.engine.validOutcomes(c.w, 'verify');
  assert.ok(check.includes('pass') && check.includes('fail'));
  assert.ok(check.includes('regression') && check.includes('env') && check.includes('stuck'), 'verify has escalation edges');
});

// ---- custom graphs ----
test('edge choice: exact beats alias beats *', async () => {
  const e = await E();
  const w = wf([node('s'), node('a', 'end'), node('b', 'end'), node('c', 'end')], [edge('s', 'a', 'done'), edge('s', 'b', 'pass'), edge('s', 'c', '*')]);
  const run = (outcome) => e.completeStage(w, e.startState(w), { stage: 's', outcome });
  assert.deepEqual(run('pass').state.active, []);
  assert.equal(run('pass').state.status, 'done');
  assert.equal(run('pass').left[0], 's');
  assert.equal(run('pass').entered[0], 'b');
  assert.equal(run('done').entered[0], 'a');
  assert.equal(run('stuck').entered[0], 'c', '* catches an outcome with no edge');
  assert.equal(run('fail').entered[0], 'c', 'fail has no alias target here, so * applies');
});

test('alias: a fail outcome follows a finding edge and the other way round', async () => {
  const e = await E();
  const w = wf([node('k', 'check'), node('ok', 'end'), node('bad', 'end')], [edge('k', 'ok', 'pass'), edge('k', 'bad', 'finding')]);
  assert.equal(e.completeStage(w, e.startState(w), { stage: 'k', outcome: 'fail' }).entered[0], 'bad');
  assert.equal(e.completeStage(w, e.startState(w), { stage: 'k', outcome: 'done' }).entered[0], 'ok');
});

test('the end node id decides the final status: stopped vs done', async () => {
  const e = await E();
  const w = wf([node('s'), node('done', 'end'), node('stopped', 'end')], [edge('s', 'done', 'done'), edge('s', 'stopped', 'stuck')]);
  assert.equal(e.completeStage(w, e.startState(w), { stage: 's', outcome: 'done' }).state.status, 'done');
  assert.equal(e.completeStage(w, e.startState(w), { stage: 's', outcome: 'stuck' }).state.status, 'stopped');
});

test('three-way split joins only after all three; nested split/join works', async () => {
  const e = await E();
  const w = wf(
    [node('sp', 'split'), node('a'), node('b'), node('c'), node('j', 'join'), node('after'), node('end', 'end')],
    [edge('sp', 'a', '*'), edge('sp', 'b', '*'), edge('sp', 'c', '*'), edge('a', 'j', 'done'), edge('b', 'j', 'done'), edge('c', 'j', 'done'), edge('j', 'after', '*'), edge('after', 'end', 'done')],
  );
  let s = e.startState(w);
  assert.deepEqual(sorted(s.active), ['a', 'b', 'c'], 'a start node that is a split enters all targets');
  for (const id of ['b', 'a']) { s = e.completeStage(w, s, { stage: id, outcome: 'done' }).state; assert.ok(!s.active.includes('after')); }
  s = e.completeStage(w, s, { stage: 'c', outcome: 'done' }).state;
  assert.deepEqual(s.active, ['after']);

  const nested = wf(
    [node('s0'), node('sp1', 'split'), node('a'), node('sp2', 'split'), node('b'), node('d'), node('j2', 'join'), node('m'), node('j1', 'join'), node('end', 'end')],
    [edge('s0', 'sp1', 'done'), edge('sp1', 'a', '*'), edge('sp1', 'sp2', '*'), edge('sp2', 'b', '*'), edge('sp2', 'd', '*'), edge('b', 'j2', 'done'), edge('d', 'j2', 'done'), edge('j2', 'm', '*'), edge('a', 'j1', 'done'), edge('m', 'j1', 'done'), edge('j1', 'end', '*')],
  );
  s = e.startState(nested);
  s = e.completeStage(nested, s, { stage: 's0', outcome: 'done' }).state;
  assert.deepEqual(sorted(s.active), ['a', 'b', 'd']);
  for (const id of ['a', 'b']) s = e.completeStage(nested, s, { stage: id, outcome: 'done' }).state;
  assert.deepEqual(sorted(s.active), ['d']);
  s = e.completeStage(nested, s, { stage: 'd', outcome: 'done' }).state;
  assert.deepEqual(s.active, ['m'], 'inner join fired, outer still waits for m');
  s = e.completeStage(nested, s, { stage: 'm', outcome: 'done' }).state;
  assert.equal(s.status, 'done');
});

test('the decision gate cancels every parallel branch', async () => {
  const e = await E();
  const w = wf(
    [node('s0'), node('sp', 'split'), node('a'), node('b'), node('j', 'join'), node('end', 'end'), gate('decision', ['Resume', 'Stop run'])],
    [edge('s0', 'sp', 'done'), edge('sp', 'a', '*'), edge('sp', 'b', '*'), edge('a', 'j', 'done'), edge('a', 'decision', 'stuck'), edge('b', 'j', 'done'), edge('j', 'end', '*'), edge('decision', 'sp', 'Resume'), edge('decision', 'end', 'Stop run')],
  );
  let s = e.startState(w);
  s = e.completeStage(w, s, { stage: 's0', outcome: 'done' }).state;
  s = e.completeStage(w, s, { stage: 'b', outcome: 'done' }).state;
  assert.equal(Object.keys(s.joins).length, 1);
  const r = e.completeStage(w, s, { stage: 'a', outcome: 'stuck', note: 'a is stuck' });
  assert.deepEqual(r.state.active, ['decision']);
  assert.deepEqual(r.state.joins, {});
  assert.equal(r.state.status, 'waiting');
  assert.equal(r.state.ask, 'a is stuck');
  assert.deepEqual(r.left, ['a']);
  const back = e.respond(w, r.state, { action: 'Resume' });
  assert.deepEqual(sorted(back.state.active), ['a', 'b'], 'Resume restarts the parallel pair');
  assert.deepEqual(back.state.joins, {});
});

test('a custom loop.decision id receives the round-limit stop', async () => {
  const e = await E();
  const w = wf(
    [node('s'), node('c', 'check'), node('f'), gate('ask-ryan', ['Go on']), node('end', 'end')],
    [edge('s', 'c', 'done'), edge('c', 'end', 'pass'), edge('c', 'f', 'fail', { fixRound: true }), edge('f', 'c', 'done'), edge('c', 'ask-ryan', 'regression'), edge('ask-ryan', 'end', 'Go on')],
    { maxRounds: 2, decision: 'ask-ryan' },
  );
  let s = e.startState(w);
  s = e.completeStage(w, s, { stage: 's', outcome: 'done' }).state;
  for (let i = 0; i < 2; i++) { s = e.completeStage(w, s, { stage: 'c', outcome: 'fail' }).state; s = e.completeStage(w, s, { stage: 'f', outcome: 'done' }).state; }
  s = e.completeStage(w, s, { stage: 'c', outcome: 'fail', note: 'n' }).state;
  assert.deepEqual(s.active, ['ask-ryan']);
  assert.equal(s.ask, 'n (fix round limit 2 reached)');
});

test('a fixRound edge always adds one, even when the target is not called fix', async () => {
  const e = await E();
  const w = wf([node('s0'), node('c', 'check'), node('retry'), node('end', 'end'), gate('decision', ['Stop'])],
    [edge('s0', 'c', 'done'), edge('c', 'end', 'pass'), edge('c', 'retry', 'fail', { fixRound: true }), edge('retry', 'c', 'done'), edge('c', 'decision', 'stuck'), edge('decision', 'end', 'Stop')]);
  let s = e.startState(w);
  s = e.completeStage(w, s, { stage: 's0', outcome: 'done' }).state;
  s = e.completeStage(w, s, { stage: 'c', outcome: 'fail' }).state;
  assert.equal(s.round, 1);
  s = e.completeStage(w, s, { stage: 'retry', outcome: 'done' }).state;
  s = e.completeStage(w, s, { stage: 'c', outcome: 'pass' }).state;
  assert.equal(s.round, 1);
});

test('a gate cannot be completed through complete_stage in a parallel run either', async () => {
  const e = await E();
  const w = wf([node('s'), gate('g', ['Go']), node('end', 'end')], [edge('s', 'g', 'done'), edge('g', 'end', 'Go')]);
  let s = e.completeStage(w, e.startState(w), { stage: 's', outcome: 'done' }).state;
  assert.equal(e.completeStage(w, s, { stage: 'g', outcome: 'done' }).error, "Run is waiting on Ryan at 'g'; use respond.");
  s = e.respond(w, s, { action: 'Go' }).state;
  assert.equal(s.status, 'done');
});
