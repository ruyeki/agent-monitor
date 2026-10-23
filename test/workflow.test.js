import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkflow, normalizeWorkflow, validateWorkflow, SYNTHETIC } from '../src/workflow.js';

const seed = () => seedWorkflow();
const errorsFor = (mutate) => {
  const wf = seed();
  mutate(wf);
  return validateWorkflow(wf);
};
const stage = (wf, id) => wf.stages.find((s) => s.id === id);

test('seed v1 has the agreed spine and is valid', () => {
  const wf = seed();
  assert.deepEqual(wf.stages.map((s) => s.id), ['frame', 'gate1', 'plan', 'implement', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr']);
  assert.deepEqual(validateWorkflow(wf), []);
  assert.deepEqual(wf.stages.filter((s) => s.check).map((s) => s.id), ['verify', 'review', 'whitehat']);
  assert.deepEqual(wf.stages.filter((s) => s.pushes).map((s) => s.id), ['pr']);
  assert.equal(stage(wf, 'plan').model, 'opus');
  assert.deepEqual(wf.loop, { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' });
});

test('every seed step tells the agent to call complete_stage, in short plain text', () => {
  for (const s of seed().stages.filter((x) => x.kind === 'step')) {
    assert.match(s.instructions, /complete_stage/, s.id);
    assert.ok(s.instructions.length < 420, s.id);
  }
});

test('normalizeWorkflow fills defaults and survives junk', () => {
  const wf = normalizeWorkflow({ stages: [{ id: 'a', name: 'A', runner: 'worker' }, 'junk', { id: 'g', name: 'G', kind: 'gate', ask: 'q', actions: [{ label: 'Ok', goto: 'next' }] }] });
  assert.equal(wf.stages.length, 2);
  assert.deepEqual([wf.stages[0].model, wf.stages[0].check, wf.stages[0].pushes, wf.stages[0].instructions], ['inherit', null, false, '']);
  assert.equal(wf.stages[1].textField, true);
  assert.equal(wf.loop.maxRounds, 5);
  assert.deepEqual(normalizeWorkflow(null).stages, []);
  assert.deepEqual(wf.loop, { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' });
});

test('normalize fills a loop default only for a missing key; other values are kept for validation', () => {
  for (const n of [null, '5', 1.5, 0, 11]) {
    assert.equal(normalizeWorkflow({ stages: [], loop: { maxRounds: n } }).loop.maxRounds, n);
    assert.ok(errorsFor((w) => { w.loop.maxRounds = n; }).some((e) => /maxRounds/.test(e)), String(n));
  }
  assert.equal(normalizeWorkflow({ stages: [], loop: { afterFix: null } }).loop.afterFix, null);
});

test('loop: fixRunner and fixModel must be known', () => {
  assert.ok(errorsFor((w) => { w.loop.fixRunner = 'robot'; }).some((e) => /fixRunner 'robot'/.test(e)));
  assert.ok(errorsFor((w) => { w.loop.fixModel = 'gpt'; }).some((e) => /fixModel 'gpt'/.test(e)));
  assert.ok(errorsFor((w) => { w.loop.fixRunner = null; }).some((e) => /fixRunner/.test(e)));
});

test('seed wording: frame stops at the problem card, plan tells the main session how to hand over', () => {
  const wf = seedWorkflow();
  const by = (id) => wf.stages.find((s) => s.id === id).instructions;
  assert.match(by('frame'), /read-only/);
  assert.match(by('frame'), /problem card/);
  assert.doesNotMatch(by('frame'), /agree the spec with/i);
  assert.match(by('plan'), /^After Gate 1, write the agreed spec into the task and spawn the lead with RUN: <id> in its brief./);
});

test('ids must be non-empty, unique, well formed and not reserved', () => {
  assert.match(errorsFor((w) => { stage(w, 'plan').id = ''; })[0], /no id/);
  assert.ok(errorsFor((w) => { stage(w, 'plan').id = 'Bad Id'; }).some((e) => /'Bad Id' has an invalid id/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'plan').id = '1plan'; }).some((e) => /invalid id/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'plan').id = 'implement'; }).some((e) => /'implement' has an id that another stage already uses/.test(e)));
  for (const id of [...SYNTHETIC, 'next', 'stop']) {
    assert.ok(errorsFor((w) => { stage(w, 'plan').id = id; }).some((e) => e.includes(`'${id}' uses a reserved id`)), id);
  }
});

test('names must be non-empty', () => {
  assert.ok(errorsFor((w) => { stage(w, 'plan').name = '  '; }).some((e) => /'plan' has no name/.test(e)));
});

test('steps need a valid runner and every stage a valid model', () => {
  assert.ok(errorsFor((w) => { stage(w, 'plan').runner = 'robot'; }).some((e) => /'plan' has an unknown runner 'robot'/.test(e)));
  assert.ok(errorsFor((w) => { delete stage(w, 'plan').runner; }).some((e) => /'plan' has an unknown runner/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'plan').model = 'gpt'; }).some((e) => /'plan' has an unknown model 'gpt'/.test(e)));
});

test('gates need an ask and actions; every goto is next, stop or a stage', () => {
  assert.ok(errorsFor((w) => { stage(w, 'gate1').ask = ''; }).some((e) => /'gate1' is a gate and needs a question/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'gate1').actions = []; }).some((e) => /'gate1' is a gate and needs at least one action/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'gate1').actions[0].goto = 'nowhere'; }).some((e) => /'gate1' action 'Agree spec' goes to 'nowhere'/.test(e)));
  assert.deepEqual(errorsFor((w) => { stage(w, 'gate1').actions[0].goto = 'plan'; }), []);
});

test('onFail must be valid', () => {
  assert.ok(errorsFor((w) => { stage(w, 'verify').check.onFail = 'explode'; }).some((e) => /'verify' has an unknown onFail 'explode'/.test(e)));
});

test('loop: afterFix and resumeAt must be stages; maxRounds an integer from 1 to 10', () => {
  assert.ok(errorsFor((w) => { w.loop.afterFix = 'zzz'; }).some((e) => /afterFix 'zzz'/.test(e)));
  assert.ok(errorsFor((w) => { w.loop.resumeAt = 'zzz'; }).some((e) => /resumeAt 'zzz'/.test(e)));
  for (const n of [0, 11, 2.5, '3']) assert.ok(errorsFor((w) => { w.loop.maxRounds = n; }).some((e) => /maxRounds/.test(e)), String(n));
  assert.deepEqual(errorsFor((w) => { w.loop.maxRounds = 10; }), []);
});

test('at least one stage needs a check', () => {
  assert.ok(errorsFor((w) => { for (const s of w.stages) s.check = null; }).some((e) => /At least one stage needs a check/.test(e)));
});

test('a pushing stage needs a gate after every check stage and before itself', () => {
  assert.ok(errorsFor((w) => { stage(w, 'gate2').kind = 'step'; stage(w, 'gate2').runner = 'main'; }).some((e) => /'pr' pushes/.test(e)));
  // gate2 moved before the last check stage: no longer valid
  assert.ok(errorsFor((w) => {
    const [g] = w.stages.splice(w.stages.findIndex((s) => s.id === 'gate2'), 1);
    w.stages.splice(w.stages.findIndex((s) => s.id === 'review'), 0, g);
  }).some((e) => /'pr' pushes/.test(e)));
  assert.ok(errorsFor((w) => { stage(w, 'frame').pushes = true; }).some((e) => /'frame' pushes/.test(e)));
});

test('an empty workflow is invalid', () => {
  assert.ok(validateWorkflow({ stages: [] }).some((e) => /at least one stage/.test(e)));
  assert.ok(validateWorkflow(null).length > 0);
});
