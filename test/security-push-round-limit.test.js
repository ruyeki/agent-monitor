// EXPLOIT: the push-rule walk (validateWorkflow step 6) follows only the explicit edges. The engine has one
// more edge: a fixRound edge past maxRounds goes to loop.decision instead. From a step in phase 0 (no check yet)
// that hidden edge enters the decision gate in phase 0, so a decision action that leads to a pushes node is
// reached with NO check having run. Validation accepts the workflow; the engine pushes.
// Secure behaviour asserted: validateWorkflow refuses this workflow with an error on 'pr'.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { REPO, load } from './holdout-helpers.js';
const { validateWorkflow, normalizeWorkflow } = await load('src/workflow.js');
const engine = await load('src/engine.js');

const step = (id, type = 'step', extra = {}) => ({ id, type, name: id, runner: 'worker', model: 'sonnet', instructions: '', ...extra });
const gate = (id, labels) => ({ id, type: 'gate', name: id, ask: `${id}?`, actions: labels.map((label) => ({ label })) });
const end = (id) => ({ id, type: 'end', name: id });
const e = (from, to, on, fixRound = false) => ({ id: `${from}>${to}:${on}`, from, to, on, fixRound });

const wf = normalizeWorkflow({
  nodes: [step('a'), step('b'), step('c', 'check'), gate('gate2', ['Accept', 'Stop run']), step('pr', 'step', { runner: 'main', pushes: true }),
    gate('decision', ['Resume', 'Stop run']), end('done'), end('stopped')],
  edges: [
    e('a', 'b', 'done', true), e('b', 'c', 'done', true), // fix-round edges on plain steps, before any check
    e('c', 'gate2', 'pass'), e('c', 'decision', 'fail'),
    e('gate2', 'pr', 'Accept'), e('gate2', 'stopped', 'Stop run'),
    e('decision', 'pr', 'Resume'), e('decision', 'stopped', 'Stop run'),
    e('pr', 'done', 'done'),
  ],
  loop: { maxRounds: 1, decision: 'decision' },
});

test('engine reaches the pushes node without any check having run', () => {
  let s = engine.startState(wf);
  const seen = [...s.active];
  for (const stage of ['a', 'b']) {
    const r = engine.completeStage(wf, s, { stage, outcome: 'done' });
    assert.ok(r.ok, r.error);
    s = r.state; seen.push(...r.entered);
  }
  assert.deepEqual(s.active, ['decision'], 'round limit sent the run to the decision gate');
  const r = engine.respond(wf, s, { action: 'Resume' });
  assert.ok(r.ok, r.error);
  seen.push(...r.entered);
  assert.deepEqual(r.state.active, ['pr']);
  assert.ok(!seen.includes('c'), 'no check node was ever entered');
});

test('validation must refuse it (fails today: the workflow is accepted)', () => {
  const errors = validateWorkflow(wf);
  assert.ok(errors.some((x) => x.node === 'pr' && /pushes/.test(x.message)),
    `push rule did not fire; errors: ${JSON.stringify(errors.map((x) => x.message))}`);
});
