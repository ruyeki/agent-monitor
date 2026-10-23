import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './holdout-helpers.js';

const W = await load('src/workflow.js').catch((e) => { throw new Error('cannot load src/workflow.js: ' + e.message); });
const seed = () => structuredClone(W.seedWorkflow());
const stage = (wf, id) => wf.stages.find((s) => s.id === id);
const errs = (wf) => W.validateWorkflow(wf);
const mentions = (list, ...needles) => list.some((e) => needles.every((n) => e.toLowerCase().includes(String(n).toLowerCase())));

// ---- AC2: exports + normalize defaults
test('AC2 exports constants', () => {
  assert.deepEqual([...W.SYNTHETIC], ['fix', 'decision', 'done', 'stopped']);
  for (const r of ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom']) assert.ok(W.RUNNERS.includes(r), r);
  for (const m of ['inherit', 'haiku', 'sonnet', 'opus', 'fable']) assert.ok(W.MODELS.includes(m), m);
  for (const f of ['fix', 'decision', 'continue']) assert.ok(W.ON_FAIL.includes(f), f);
});

test('AC2 normalize fills loop defaults when loop is missing or partial', () => {
  const a = W.normalizeWorkflow({ stages: [{ id: 'a', name: 'A', kind: 'step', runner: 'main' }] });
  assert.deepEqual(a.loop, { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' });
  const b = W.normalizeWorkflow({ stages: [], loop: { maxRounds: 3 } });
  assert.equal(b.loop.maxRounds, 3);
  assert.equal(b.loop.fixRunner, 'worker');
  assert.equal(b.loop.afterFix, 'verify');
  assert.equal(b.loop.resumeAt, 'plan');
});

test('AC2 normalize fills stage defaults', () => {
  const n = W.normalizeWorkflow({ stages: [{ id: 'a', name: 'A', kind: 'step', runner: 'worker' }] });
  const s = n.stages[0];
  assert.equal(s.model, 'inherit');
  assert.equal(s.check, null);
  assert.equal(s.pushes, false);
  assert.equal(typeof s.instructions, 'string');
});

test('AC2 normalize fills gate defaults and keeps given values', () => {
  const n = W.normalizeWorkflow({ stages: [
    { id: 'g', name: 'G', kind: 'gate' },
    { id: 'c', name: 'C', kind: 'step', runner: 'verifier', model: 'opus', check: {}, pushes: true, instructions: 'hi' },
  ] });
  const g = n.stages[0];
  assert.ok(Array.isArray(g.actions));
  assert.equal(typeof g.ask, 'string');
  const c = n.stages[1];
  assert.equal(c.model, 'opus');
  assert.equal(c.pushes, true);
  assert.equal(c.instructions, 'hi');
  assert.ok(c.check && typeof c.check === 'object');
  assert.equal(c.check.onFail, 'fix', 'check without onFail defaults to fix');
});

test('AC2 normalize tolerates garbage and does not throw', () => {
  for (const bad of [undefined, null, {}, { stages: 'x' }, { stages: [null, 1] }]) {
    let out;
    assert.doesNotThrow(() => { out = W.normalizeWorkflow(bad); });
    assert.ok(out && Array.isArray(out.stages));
    assert.ok(out.loop && out.loop.maxRounds);
  }
});

test('AC2 normalize does not mutate its input', () => {
  const input = { stages: [{ id: 'a', name: 'A', kind: 'step', runner: 'main' }] };
  const copy = structuredClone(input);
  W.normalizeWorkflow(input);
  assert.deepEqual(input, copy);
});

// ---- AC3: seed v1
test('AC3 seed v1 order, kinds, runners, models', () => {
  const wf = seed();
  assert.deepEqual(wf.stages.map((s) => s.id), ['frame', 'gate1', 'plan', 'implement', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr']);
  const spec = {
    frame: ['step', 'main', 'inherit'], gate1: ['gate'], plan: ['step', 'lead', 'opus'],
    implement: ['step', 'worker', 'sonnet'], verify: ['step', 'verifier', 'sonnet'],
    review: ['step', 'lead', 'inherit'], whitehat: ['step', 'white-hat', 'sonnet'],
    commit: ['step', 'lead'], report: ['step', 'lead'], gate2: ['gate'], pr: ['step', 'main', 'inherit'],
  };
  for (const [id, [kind, runner, model]] of Object.entries(spec)) {
    const s = stage(wf, id);
    assert.equal(s.kind, kind, id + ' kind');
    if (runner) assert.equal(s.runner, runner, id + ' runner');
    if (model) assert.equal(s.model, model, id + ' model');
  }
});

test('AC3 seed v1 checks, pushes, loop', () => {
  const wf = seed();
  for (const id of ['verify', 'review', 'whitehat']) assert.equal(stage(wf, id).check?.onFail, 'fix', id);
  for (const id of ['frame', 'plan', 'implement', 'commit', 'report', 'pr']) assert.ok(!stage(wf, id).check, id + ' has no check');
  assert.deepEqual(wf.stages.filter((s) => s.pushes).map((s) => s.id), ['pr']);
  assert.deepEqual(wf.loop, { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' });
});

test('AC3 seed v1 gates ask and actions', () => {
  const wf = seed();
  const g1 = stage(wf, 'gate1');
  assert.equal(g1.ask, "What's your solution?");
  assert.deepEqual(g1.actions.map((a) => [a.label, a.goto]), [['Agree spec', 'next'], ['Stop run', 'stop']]);
  assert.equal(g1.textField, true);
  const g2 = stage(wf, 'gate2');
  assert.equal(g2.ask, 'Accept, push and open the PR?');
  assert.deepEqual(g2.actions.map((a) => [a.label, a.goto]), [['Accept', 'next'], ['Request changes', 'plan'], ['Stop run', 'stop']]);
  assert.equal(g2.textField, true);
});

test('AC3 seed v1 every stage has a name and instructions; seed validates and is stable', () => {
  const wf = seed();
  for (const s of wf.stages) {
    assert.ok(s.name && s.name.trim(), s.id + ' name');
    if (s.kind === 'step') assert.ok(s.instructions && s.instructions.trim().length > 10, s.id + ' instructions');
  }
  assert.deepEqual(errs(wf), []);
  assert.deepEqual(W.validateWorkflow(W.normalizeWorkflow(wf)), []);
  assert.deepEqual(W.normalizeWorkflow(wf), wf, 'normalize of the seed is a no-op');
  assert.notEqual(W.seedWorkflow(), W.seedWorkflow(), 'seedWorkflow returns a fresh object each call');
});

test('AC3 seed never mentions the old product name', () => {
  assert.ok(!/fable radar/i.test(JSON.stringify(W.seedWorkflow())));
});

// ---- AC6: validation rules
test('AC6 duplicate and empty ids', () => {
  let wf = seed(); wf.stages[2].id = 'frame';
  assert.ok(mentions(errs(wf), 'frame'), 'dup id names the stage');
  wf = seed(); wf.stages[2].id = '';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); wf.stages[2].id = '   ';
  assert.ok(errs(wf).length >= 1);
});

test('AC6 id pattern', () => {
  for (const bad of ['Bad', '1abc', 'has space', '-x', '_x', 'a.b', 'a/b']) {
    const wf = seed(); stage(wf, 'plan').id = bad; wf.loop.resumeAt = bad; stage(wf, 'gate2').actions[1].goto = bad;
    assert.ok(errs(wf).length >= 1, 'id ' + JSON.stringify(bad) + ' should be rejected');
  }
  for (const ok of ['a', 'a1', 'a-b_c9', 'x'.repeat(40)]) {
    const wf = seed(); stage(wf, 'plan').id = ok; wf.loop.resumeAt = ok;
    stage(wf, 'gate2').actions[1].goto = ok;
    assert.deepEqual(errs(wf), [], 'id ' + ok + ' should be valid');
  }
});

test('AC6 synthetic and reserved ids rejected', () => {
  for (const bad of ['fix', 'decision', 'done', 'stopped', 'next', 'stop']) {
    const wf = seed(); stage(wf, 'plan').id = bad; wf.loop.resumeAt = bad; stage(wf, 'gate2').actions[1].goto = bad;
    const e = errs(wf);
    assert.ok(e.length >= 1, bad + ' should be rejected');
    assert.ok(mentions(e, bad), 'error names ' + bad + ': ' + e.join(' | '));
  }
});

test('AC6 empty name, bad runner, bad model', () => {
  let wf = seed(); stage(wf, 'plan').name = '';
  assert.ok(mentions(errs(wf), 'plan'));
  wf = seed(); stage(wf, 'plan').name = '  ';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); stage(wf, 'implement').runner = 'robot';
  assert.ok(mentions(errs(wf), 'implement'));
  wf = seed(); delete stage(wf, 'implement').runner;
  assert.ok(mentions(errs(wf), 'implement'));
  wf = seed(); stage(wf, 'implement').model = 'gpt';
  assert.ok(mentions(errs(wf), 'implement'));
});

test('AC6 gate rules: ask, actions, goto', () => {
  let wf = seed(); stage(wf, 'gate1').ask = '';
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); stage(wf, 'gate1').ask = '   ';
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); stage(wf, 'gate1').actions = [];
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); stage(wf, 'gate1').actions[0].goto = 'nowhere';
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); stage(wf, 'gate1').actions[0].goto = 'implement';
  assert.deepEqual(errs(wf), [], 'goto an existing stage is valid');
  wf = seed(); stage(wf, 'gate1').actions[0].goto = 'stop';
  assert.deepEqual(errs(wf), []);
});

test('AC6 check onFail and loop references', () => {
  let wf = seed(); stage(wf, 'verify').check.onFail = 'explode';
  assert.ok(mentions(errs(wf), 'verify'));
  wf = seed(); stage(wf, 'verify').check.onFail = 'continue';
  assert.deepEqual(errs(wf), []);
  wf = seed(); stage(wf, 'verify').check.onFail = 'decision';
  assert.deepEqual(errs(wf), []);
  wf = seed(); wf.loop.afterFix = 'ghost';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); wf.loop.resumeAt = 'ghost';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); wf.loop.afterFix = 'fix';
  assert.ok(errs(wf).length >= 1, 'afterFix must be a real stage');
});

test('AC6 at least one check stage is required', () => {
  const wf = seed();
  for (const id of ['verify', 'review', 'whitehat']) stage(wf, id).check = null;
  assert.ok(errs(wf).length >= 1);
});

test('AC6 maxRounds boundaries', () => {
  for (const [v, ok] of [[0, false], [11, false], [-1, false], [1.5, false], ['5', false], [null, false], [1, true], [10, true], [5, true]]) {
    const wf = seed(); wf.loop.maxRounds = v;
    const e = errs(wf);
    assert.equal(e.length === 0, ok, 'maxRounds ' + JSON.stringify(v) + ' -> ' + e.join(' | '));
  }
});

test('AC6 pushes stage needs a gate before it', () => {
  // gate2 moved after pr: the pushing stage has no later-than-checks gate before it
  let wf = seed();
  const pr = wf.stages.pop(); const g2 = wf.stages.pop();
  wf.stages.push(pr, g2);
  const e = errs(wf);
  assert.ok(e.length >= 1);
  assert.ok(mentions(e, 'pr'), 'error names the pushing stage: ' + e.join(' | '));
});

test('AC6 no gate at all before a pushing stage', () => {
  const wf = seed();
  wf.stages = wf.stages.filter((s) => s.id !== 'gate2');
  stage(wf, 'gate1').actions = stage(wf, 'gate1').actions.filter((a) => a.goto !== 'gate2');
  assert.ok(errs(wf).length >= 1, 'gate1 sits before every check, so it cannot guard the push');
});

test('AC6 the gate before a pushing stage must come after every check stage', () => {
  const wf = seed();
  const g2 = wf.stages.find((s) => s.id === 'gate2');
  wf.stages = wf.stages.filter((s) => s.id !== 'gate2');
  const at = wf.stages.findIndex((s) => s.id === 'review');
  wf.stages.splice(at, 0, g2); // gate now sits between verify and review
  const e = errs(wf);
  assert.ok(e.length >= 1, 'gate before the review/whitehat checks does not guard the push');
  assert.ok(mentions(e, 'pr'), e.join(' | '));
});

test('AC6 valid minimal workflow: check, gate after it, push after the gate', () => {
  const wf = {
    stages: [
      { id: 'build', name: 'Build', kind: 'step', runner: 'worker', model: 'sonnet', instructions: 'x', check: { onFail: 'fix' }, pushes: false },
      { id: 'ok', name: 'OK?', kind: 'gate', ask: 'Ship?', actions: [{ label: 'Yes', goto: 'next' }, { label: 'No', goto: 'stop' }], textField: false },
      { id: 'ship', name: 'Ship', kind: 'step', runner: 'main', model: 'inherit', instructions: 'push', check: null, pushes: true },
    ],
    loop: { maxRounds: 3, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'build', resumeAt: 'build' },
  };
  assert.deepEqual(errs(wf), []);
  wf.stages.reverse();
  assert.ok(errs(wf).length >= 1);
});

test('AC6 errors are human sentences naming the stage', () => {
  const wf = seed(); stage(wf, 'implement').runner = 'robot'; stage(wf, 'whitehat').model = 'zz';
  const e = errs(wf);
  assert.ok(Array.isArray(e) && e.every((x) => typeof x === 'string' && x.length > 8));
  assert.ok(mentions(e, 'implement') && mentions(e, 'whitehat'));
});

test('AC6 validate does not throw on garbage', () => {
  for (const bad of [{}, { stages: [] }, { stages: [{}] }, { stages: [null] }]) {
    let e; assert.doesNotThrow(() => { e = errs(bad); });
    assert.ok(e.length >= 1);
  }
});
