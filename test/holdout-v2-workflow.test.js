// Holdout: AC1 (format), AC2 (seed), AC3 (fromSpine), AC5 + AC14 (validation, push rule). Pure module tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, fixture, clone } from './holdout-v2-helpers.js';

const W = () => load('src/workflow.js');
const spine = () => fixture('workflow-v1.json');

// ---- tiny graph builders ----
const node = (id, type = 'step', extra = {}) => ({
  id, type, name: `Node ${id}`, runner: 'worker', model: 'inherit', instructions: 'do it', position: { x: 0, y: 0 }, ...extra,
});
const gate = (id, labels = ['Go'], extra = {}) => node(id, 'gate', { runner: 'main', ask: 'Ok?', actions: labels.map((label) => ({ label })), textField: true, ...extra });
let eid = 0;
const edge = (from, to, on, extra = {}) => ({ id: `e${++eid}`, from, to, on, ...extra });
const wf = (nodes, edges, loop = {}) => ({ nodes, edges, loop: { maxRounds: 5, decision: 'decision', ...loop } });

// start s -> check c -> gate g -> push p -> end
const mini = () => wf(
  [node('s'), node('c', 'check', { runner: 'verifier' }), gate('g'), node('p', 'step', { pushes: true }), node('end', 'end')],
  [edge('s', 'c', 'done'), edge('c', 'g', 'pass'), edge('c', 'end', 'fail'), edge('g', 'p', 'Go'), edge('p', 'end', 'done')],
);
// s -> split -> a,b -> join -> check c -> gate g -> push p -> end
const par = () => wf(
  [node('s'), node('sp', 'split'), node('a'), node('b'), node('j', 'join'), node('c', 'check', { runner: 'verifier' }), gate('g'), node('p', 'step', { pushes: true }), node('end', 'end')],
  [edge('s', 'sp', 'done'), edge('sp', 'a', '*'), edge('sp', 'b', '*'), edge('a', 'j', 'done'), edge('b', 'j', 'done'), edge('j', 'c', '*'),
    edge('c', 'g', 'pass'), edge('c', 'end', 'fail'), edge('g', 'p', 'Go'), edge('p', 'end', 'done')],
);
// mini plus a fix loop and a decision gate
const withFix = () => {
  const w = mini();
  w.nodes.push(node('fix'), gate('decision', ['Resume', 'Stop run']));
  w.edges = w.edges.filter((e) => !(e.from === 'c' && e.on === 'fail'));
  w.edges.push(edge('c', 'fix', 'fail', { fixRound: true }), edge('fix', 'c', 'done'), edge('c', 'decision', 'regression'),
    edge('decision', 'c', 'Resume'), edge('decision', 'end', 'Stop run'));
  return w;
};
const without = (w, id) => ({ ...w, nodes: w.nodes.filter((n) => n.id !== id), edges: w.edges.filter((e) => e.from !== id && e.to !== id) });
const dropEdge = (w, from, on) => ({ ...w, edges: w.edges.filter((e) => !(e.from === from && e.on === on)) });
const retarget = (w, from, on, to) => ({ ...w, edges: w.edges.map((e) => (e.from === from && e.on === on ? { ...e, to } : e)) });

const mentions = (errors, id) => errors.some((e) => e.node === id || e.edge === id || String(e.message).includes(id));
async function errorsOf(w) {
  const { validateWorkflow } = await W();
  const errors = validateWorkflow(w);
  assert.ok(Array.isArray(errors));
  for (const e of errors) { assert.equal(typeof e.message, 'string'); assert.ok(e.message.length > 0); }
  return errors;
}
async function assertValid(w, why) { assert.deepEqual(await errorsOf(w), [], why); }
async function assertInvalid(w, who, why) {
  const errors = await errorsOf(w);
  assert.ok(errors.length > 0, `accepted: ${why}`);
  if (who) assert.ok(mentions(errors, who), `no error names '${who}' (${why}): ${errors.map((e) => e.message).join(' | ')}`);
}

// ================= AC1 / AC2: format and seed =================
test('module exports', async () => {
  const m = await W();
  for (const k of ['OUTCOMES', 'NODE_TYPES', 'RUNNERS', 'MODELS', 'seedWorkflow', 'fromSpine', 'normalizeWorkflow', 'validateWorkflow']) assert.ok(k in m, k);
  assert.deepEqual([...m.OUTCOMES].sort(), ['done', 'env', 'fail', 'finding', 'pass', 'regression', 'stuck']);
  assert.deepEqual([...m.NODE_TYPES].sort(), ['check', 'end', 'gate', 'join', 'split', 'step']);
});

test('seed: shape, ids, types, runners and models', async () => {
  const { seedWorkflow } = await W();
  const s = seedWorkflow();
  assert.deepEqual(Object.keys(s).sort(), ['edges', 'loop', 'nodes']);
  assert.deepEqual(s.loop, { maxRounds: 5, decision: 'decision' });
  const want = {
    frame: ['step', 'main', 'inherit'], plan: ['step', 'lead', 'opus'], implement: ['step', 'worker', 'sonnet'], prep: ['step', 'verifier', 'sonnet'],
    verify: ['check', 'verifier', 'sonnet'], fix: ['step', 'worker', 'sonnet'], review: ['check', 'lead', 'inherit'], whitehat: ['check', 'white-hat', 'sonnet'],
    commit: ['step', 'lead'], report: ['step', 'lead'], pr: ['step', 'main', 'inherit'],
    gate1: ['gate'], gate2: ['gate'], decision: ['gate'], split: ['split'], join: ['join'], done: ['end'], stopped: ['end'],
  };
  assert.deepEqual(s.nodes.map((n) => n.id).sort(), Object.keys(want).sort());
  for (const n of s.nodes) {
    const [type, runner, model] = want[n.id];
    assert.equal(n.type, type, `${n.id} type`);
    if (runner) assert.equal(n.runner, runner, `${n.id} runner`);
    if (model) assert.equal(n.model, model, `${n.id} model`);
    assert.equal(typeof n.name, 'string');
    assert.ok(n.name.trim(), `${n.id} has a name`);
    assert.equal(typeof n.position?.x, 'number');
    assert.equal(typeof n.position?.y, 'number');
    if (['step', 'check'].includes(type)) assert.ok(n.instructions.length > 20, `${n.id} instructions`);
  }
  assert.equal(s.nodes.find((n) => n.id === 'prep').name, 'Verifier prep');
  assert.equal(s.nodes.find((n) => n.id === 'pr').pushes, true);
  assert.equal(s.nodes.filter((n) => n.pushes).length, 1);
  const pos = s.nodes.map((n) => `${n.position.x},${n.position.y}`);
  assert.equal(new Set(pos).size, pos.length, 'two nodes share a position');
});

test('seed: gates, asks and action labels match v1', async () => {
  const { seedWorkflow } = await W();
  const g = (id) => seedWorkflow().nodes.find((n) => n.id === id);
  assert.equal(g('gate1').ask, "What's your solution?");
  assert.deepEqual(g('gate1').actions.map((a) => a.label), ['Agree spec', 'Stop run']);
  assert.equal(g('gate2').ask, 'Accept, push and open the PR?');
  assert.deepEqual(g('gate2').actions.map((a) => a.label), ['Accept', 'Request changes', 'Stop run']);
  assert.equal(g('decision').ask, 'Decision needed');
  assert.deepEqual(g('decision').actions.map((a) => a.label), ['Resume', 'Stop run']);
  for (const id of ['gate1', 'gate2', 'decision']) assert.equal(g(id).textField, true);
});

test('seed: the edge set is exactly the drawn workflow', async () => {
  const { seedWorkflow } = await W();
  const s = seedWorkflow();
  const got = s.edges.map((e) => `${e.from}|${e.on}|${e.to}`).sort();
  const want = [
    'frame|done|gate1', 'gate1|Agree spec|plan', 'gate1|Stop run|stopped', 'plan|done|split', 'split|*|implement', 'split|*|prep',
    'implement|done|join', 'prep|done|join', 'join|*|verify', 'verify|pass|review', 'verify|fail|fix', 'verify|regression|decision',
    'verify|env|decision', 'verify|stuck|decision', 'fix|done|verify', 'review|pass|whitehat', 'review|finding|fix', 'whitehat|pass|commit',
    'whitehat|finding|fix', 'commit|done|report', 'report|done|gate2', 'gate2|Accept|pr', 'gate2|Request changes|plan', 'gate2|Stop run|stopped',
    'pr|done|done', 'decision|Resume|plan', 'decision|Stop run|stopped',
  ].sort();
  assert.deepEqual(got, want);
  const ids = s.edges.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'edge ids are unique');
  assert.ok(ids.every((i) => typeof i === 'string' && i));
  const fixRound = s.edges.filter((e) => e.fixRound).map((e) => `${e.from}>${e.to}`).sort();
  assert.deepEqual(fixRound, ['review>fix', 'verify>fix', 'whitehat>fix']);
});

test('seed: validates clean, and returns a fresh object each call', async () => {
  const { seedWorkflow, validateWorkflow } = await W();
  assert.deepEqual(validateWorkflow(seedWorkflow()), []);
  const a = seedWorkflow(); a.nodes[0].name = 'changed';
  assert.notEqual(seedWorkflow().nodes[0].name, 'changed');
});

test('seed: reuses the v1 instruction text where v1 had it, and the plan hands off the parallel pair', async () => {
  const { seedWorkflow } = await W();
  const s = seedWorkflow();
  const v1 = Object.fromEntries(spine().stages.map((x) => [x.id, x.instructions]));
  for (const id of ['frame', 'review', 'whitehat', 'commit', 'report', 'pr']) {
    assert.equal(s.nodes.find((n) => n.id === id).instructions, v1[id], `${id} instructions changed`);
  }
  assert.ok(s.nodes.find((n) => n.id === 'plan').instructions.endsWith('complete_stage returns implement and prep: run both together in the foreground, then report each with complete_stage.'));
  assert.equal(s.nodes.find((n) => n.id === 'fix').instructions,
    'Fix what the last check found. Make a root-cause change, not a patch over the symptom. When it is done, call complete_stage with the outcome.');
});

// ================= normalizeWorkflow =================
test('normalize: fills only missing keys', async () => {
  const { normalizeWorkflow } = await W();
  const out = normalizeWorkflow({ nodes: [{ id: 'x' }, { id: 'g', type: 'gate', ask: 'a', actions: [{ label: 'A', goto: 'junk', extra: 1 }] }], edges: [{ id: 'e', from: 'x', to: 'g', on: 'done' }] });
  const x = out.nodes[0];
  assert.equal(x.type, 'step');
  assert.equal(x.model, 'inherit');
  assert.equal(x.instructions, '');
  assert.deepEqual(x.position, { x: 0, y: 0 });
  assert.equal(x.pushes, false);
  assert.equal(x.name, undefined, 'must not invent a name');
  assert.equal(x.runner, undefined, 'must not invent a runner');
  assert.equal(out.nodes[1].textField, true);
  assert.deepEqual(out.nodes[1].actions, [{ label: 'A' }]);
  assert.equal(out.edges[0].fixRound, false);
  assert.deepEqual(out.loop, { maxRounds: 5, decision: 'decision' });
});

test('normalize: keeps null and wrong types so validation can report them; is idempotent; does not mutate', async () => {
  const { normalizeWorkflow, validateWorkflow, seedWorkflow } = await W();
  const input = { nodes: [{ id: 's', type: 'step', name: null, runner: 'worker', model: 'inherit' }], edges: [], loop: { maxRounds: null, decision: 'decision' } };
  const frozen = clone(input);
  const out = normalizeWorkflow(input);
  assert.deepEqual(input, frozen);
  assert.equal(out.nodes[0].name, null);
  assert.equal(out.loop.maxRounds, null);
  assert.ok((await errorsOf(input)).length > 0);
  const seed = seedWorkflow();
  assert.deepEqual(normalizeWorkflow(normalizeWorkflow(seed)), normalizeWorkflow(seed));
  assert.deepEqual(validateWorkflow(normalizeWorkflow(seed)), []);
});

test('normalize: a spine input (stages, no nodes) is converted to a graph', async () => {
  const { normalizeWorkflow, fromSpine } = await W();
  const out = normalizeWorkflow(spine());
  assert.ok(Array.isArray(out.nodes) && Array.isArray(out.edges));
  assert.equal(out.stages, undefined);
  assert.deepEqual(out, normalizeWorkflow(fromSpine(spine())));
});

test('normalize: garbage input does not throw', async () => {
  const { normalizeWorkflow, validateWorkflow } = await W();
  for (const g of [null, undefined, 5, 'x', [], {}, { nodes: 'x' }, { nodes: [null, 3, { id: 1 }], edges: [null] }]) {
    assert.doesNotThrow(() => normalizeWorkflow(g));
    assert.doesNotThrow(() => validateWorkflow(g));
    assert.ok(validateWorkflow(g).length > 0);
  }
});

// ================= AC3: fromSpine =================
test('fromSpine: the v1 seed converts to a valid graph with the fixed extra nodes', async () => {
  const { fromSpine, validateWorkflow } = await W();
  const g = fromSpine(spine());
  assert.deepEqual(validateWorkflow(g), []);
  const ids = g.nodes.map((n) => n.id);
  assert.deepEqual(ids.slice().sort(), [...spine().stages.map((s) => s.id), 'fix', 'decision', 'done', 'stopped'].sort());
  const t = (id) => g.nodes.find((n) => n.id === id);
  assert.equal(t('verify').type, 'check');
  assert.equal(t('review').type, 'check');
  assert.equal(t('whitehat').type, 'check');
  assert.equal(t('frame').type, 'step');
  assert.equal(t('gate2').type, 'gate');
  assert.equal(t('pr').pushes, true);
  assert.equal(t('fix').type, 'step');
  assert.equal(t('fix').runner, 'worker');
  assert.equal(t('fix').model, 'sonnet');
  assert.equal(t('decision').type, 'gate');
  assert.equal(t('decision').ask, 'Decision needed');
  assert.deepEqual(t('decision').actions.map((a) => a.label), ['Resume', 'Stop run']);
  assert.equal(t('done').type, 'end');
  assert.equal(t('stopped').type, 'end');
  assert.deepEqual(g.loop, { maxRounds: 5, decision: 'decision' });
});

test('fromSpine: edges are faithful to the v1 behaviour', async () => {
  const { fromSpine } = await W();
  const g = fromSpine(spine());
  const alias = { done: 'pass', pass: 'pass', fail: 'fail', finding: 'fail' };
  const has = (from, on, to, fixRound) => g.edges.some((e) => e.from === from && (alias[on] ? alias[e.on] === alias[on] : e.on === on) && e.to === to && (fixRound === undefined || !!e.fixRound === fixRound));
  const order = spine().stages.map((s) => s.id);
  for (const [i, s] of spine().stages.entries()) {
    if (s.kind === 'gate') continue;
    assert.ok(has(s.id, 'pass', order[i + 1] ?? 'done'), `${s.id} pass -> next`);
    for (const o of ['regression', 'env', 'stuck']) assert.ok(has(s.id, o, 'decision'), `${s.id} ${o} -> decision`);
    if (s.check?.onFail === 'fix') assert.ok(has(s.id, 'fail', 'fix', true), `${s.id} fail -> fix (fix round)`);
    if (!s.check) assert.ok(has(s.id, 'fail', 'decision'), `${s.id} has no check: fail -> decision`);
  }
  assert.ok(has('gate1', 'Agree spec', 'plan'));
  assert.ok(has('gate1', 'Stop run', 'stopped'));
  assert.ok(has('gate2', 'Accept', 'pr'));
  assert.ok(has('gate2', 'Request changes', 'plan'));
  assert.ok(has('gate2', 'Stop run', 'stopped'));
  assert.ok(has('fix', 'pass', 'verify'));
  for (const o of ['fail', 'regression', 'env', 'stuck']) assert.ok(has('fix', o, 'decision'), `fix ${o} -> decision`);
  assert.ok(has('decision', 'Resume', 'plan'));
  assert.ok(has('decision', 'Stop run', 'stopped'));
  assert.equal(g.edges.length, 57);
  assert.equal(g.edges.filter((e) => e.fixRound).length, 3);
});

test('fromSpine: positions follow the pinned layout', async () => {
  const { fromSpine } = await W();
  const g = fromSpine(spine());
  const p = (id) => g.nodes.find((n) => n.id === id).position;
  const n = spine().stages.length;
  spine().stages.forEach((s, i) => assert.deepEqual(p(s.id), { x: i * 220, y: 0 }, s.id));
  assert.deepEqual(p('done'), { x: n * 220, y: 0 });
  assert.deepEqual(p('fix'), { x: 220, y: 190 });
  assert.deepEqual(p('decision'), { x: 550, y: 190 });
  assert.deepEqual(p('stopped'), { x: Math.max(n - 1, 3) * 220, y: 190 });
});

test('fromSpine: onFail continue and decision, goto ids, custom loop settings', async () => {
  const { fromSpine } = await W();
  const v1 = spine();
  const stage = (id) => v1.stages.find((s) => s.id === id);
  stage('verify').check.onFail = 'continue';
  stage('review').check.onFail = 'decision';
  stage('gate1').actions[0].goto = 'implement';
  stage('gate2').actions[0].goto = 'next';
  v1.loop = { maxRounds: 3, fixRunner: 'opus-runner-not-checked', fixModel: 'haiku', afterFix: 'review', resumeAt: 'implement' };
  v1.loop.fixRunner = 'verifier';
  const g = fromSpine(v1);
  const on = (from, to) => g.edges.filter((e) => e.from === from && e.to === to).map((e) => e.on);
  assert.ok(on('verify', 'review').some((o) => ['fail', 'finding'].includes(o)), 'continue: fail goes to the next stage');
  assert.ok(!g.edges.some((e) => e.from === 'verify' && e.to === 'fix'), 'continue: no fix edge');
  assert.ok(on('review', 'decision').some((o) => ['fail', 'finding'].includes(o)), 'decision: fail goes to decision');
  assert.ok(!g.edges.some((e) => e.from === 'review' && e.to === 'fix'));
  assert.ok(on('gate1', 'implement').includes('Agree spec'));
  assert.ok(on('fix', 'review').length > 0, 'afterFix');
  assert.ok(on('decision', 'implement').includes('Resume'), 'resumeAt');
  const fix = g.nodes.find((n) => n.id === 'fix');
  assert.equal(fix.runner, 'verifier');
  assert.equal(fix.model, 'haiku');
  assert.equal(g.loop.maxRounds, 3);
  assert.equal(g.loop.decision, 'decision');
});

test('fromSpine: last-stage gate goto next goes to done', async () => {
  const { fromSpine } = await W();
  const v1 = { stages: [
    { id: 'a', name: 'A', kind: 'step', runner: 'worker', model: 'inherit', instructions: '', check: { onFail: 'fix' }, pushes: false },
    { id: 'g', name: 'G', kind: 'gate', runner: 'main', model: 'inherit', instructions: '', check: null, pushes: false, ask: 'q', actions: [{ label: 'Ok', goto: 'next' }], textField: false },
  ], loop: { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'a', resumeAt: 'a' } };
  const g = fromSpine(v1);
  assert.ok(g.edges.some((e) => e.from === 'g' && e.to === 'done' && e.on === 'Ok'));
  assert.equal(g.nodes.find((n) => n.id === 'g').textField, false);
});

test('fromSpine: the push guards of v1 survive the conversion (no gate -> refused)', async () => {
  const { fromSpine, validateWorkflow } = await W();
  const a = spine(); a.loop.afterFix = 'pr';
  assert.ok(validateWorkflow(fromSpine(a)).length > 0, 'afterFix -> pr');
  const b = spine(); b.stages.find((s) => s.id === 'gate1').actions[0].goto = 'pr';
  assert.ok(validateWorkflow(fromSpine(b)).length > 0, 'gate1 Agree spec -> pr');
});

// ================= AC5: validation, one rule at a time =================
test('validate: the hand-built graphs used below are valid', async () => {
  await assertValid(mini(), 'mini');
  await assertValid(par(), 'par');
  await assertValid(withFix(), 'withFix');
});

test('validate: node rules', async () => {
  let w = mini(); w.nodes.push(node('s')); await assertInvalid(w, 's', 'duplicate node id');
  w = mini(); w.nodes[0].id = 'Bad Id'; w.edges = w.edges.map((e) => ({ ...e, from: e.from === 's' ? 'Bad Id' : e.from })); await assertInvalid(w, 'Bad Id', 'invalid id');
  w = mini(); w.nodes.push(node('x'.repeat(81))); await assertInvalid(w, null, 'id longer than 80');
  w = mini(); w.nodes.find((n) => n.id === 's').name = ' '; await assertInvalid(w, 's', 'empty name');
  w = mini(); w.nodes.find((n) => n.id === 's').type = 'wat'; await assertInvalid(w, 's', 'unknown type');
  w = mini(); w.nodes.find((n) => n.id === 's').runner = 'robot'; await assertInvalid(w, 's', 'unknown runner');
  w = mini(); w.nodes.find((n) => n.id === 'c').model = 'gpt'; await assertInvalid(w, 'c', 'unknown model');
});

test('validate: gate rules', async () => {
  let w = mini(); w.nodes.find((n) => n.id === 'g').ask = ' '; await assertInvalid(w, 'g', 'gate without a question');
  w = mini(); w.nodes.find((n) => n.id === 'g').actions = []; await assertInvalid(w, 'g', 'gate without actions');
  w = mini(); w.nodes.find((n) => n.id === 'g').actions = Array.from({ length: 11 }, (_, i) => ({ label: `A${i}` })); await assertInvalid(w, 'g', '11 actions');
  w = mini(); w.nodes.find((n) => n.id === 'g').actions = [{ label: 'Go' }, { label: 'GO' }]; await assertInvalid(w, 'g', 'labels equal ignoring case');
  w = mini(); w.nodes.find((n) => n.id === 'g').actions = [{ label: 'Go' }, { label: '' }]; await assertInvalid(w, 'g', 'empty label');
  w = mini(); w.nodes.find((n) => n.id === 'g').actions.push({ label: 'Other' }); await assertInvalid(w, 'g', 'an action with no edge');
  w = mini(); w.edges.push(edge('g', 'end', 'Nope')); await assertInvalid(w, 'g', 'an edge on a label the gate does not have');
  w = mini(); w.edges.push(edge('g', 'end', 'Go')); await assertInvalid(w, 'g', 'two edges for one action');
});

test('validate: edge rules', async () => {
  let w = mini(); w.edges.push(edge('s', 'ghost', 'regression')); await assertInvalid(w, 'ghost', 'edge to a missing node');
  w = mini(); w.edges.push(edge('ghost', 'end', 'done')); await assertInvalid(w, 'ghost', 'edge from a missing node');
  w = mini(); w.edges[1].id = w.edges[0].id; await assertInvalid(w, w.edges[0].id, 'duplicate edge id');
  w = mini(); w.edges[0].id = ''; await assertInvalid(w, null, 'empty edge id');
  w = mini(); w.edges.push(edge('s', 'end', 'Go')); await assertInvalid(w, 's', 'a gate label on a step edge');
  w = mini(); w.edges.push(edge('s', 'end', 'bogus')); await assertInvalid(w, 's', 'unknown on');
  w = mini(); w.edges.push(edge('c', 'end', 'pass')); await assertInvalid(w, 'c', 'two edges with the same on');
  w = mini(); w.edges.push(edge('end', 's', 'done')); await assertInvalid(w, 'end', 'an end node with an outgoing edge');
});

test('validate: step and check need an edge for every outcome they produce, or *', async () => {
  let w = mini(); w = dropEdge(w, 's', 'done'); w.edges.push(edge('s', 'end', 'fail')); await assertInvalid(w, 's', 'step without a success edge');
  w = mini(); w = dropEdge(w, 'c', 'fail'); await assertInvalid(w, 'c', 'check without a failure edge');
  w = mini(); w = dropEdge(w, 'c', 'pass'); await assertInvalid(w, 'c', 'check without a success edge');
  w = mini(); w = dropEdge(w, 'c', 'pass'); w = dropEdge(w, 'c', 'fail'); w.edges.push(edge('c', 'g', '*')); await assertValid(w, 'a check with only a * edge');
  w = mini(); w = dropEdge(w, 's', 'done'); w.edges.push(edge('s', 'c', '*')); await assertValid(w, 'a step with only a * edge');
  w = mini(); w.edges.find((e) => e.from === 's').on = 'pass'; await assertValid(w, 'step success may be written pass');
  w = mini(); w.edges.find((e) => e.from === 'c' && e.on === 'pass').on = 'done'; w.edges.find((e) => e.from === 'c' && e.on === 'fail').on = 'finding'; await assertValid(w, 'check aliases done / finding');
  w = mini(); w.edges.push(edge('s', 'end', 'stuck'), edge('s', 'end', 'env'), edge('s', 'end', 'regression')); await assertValid(w, 'optional escalation edges');
});

test('validate: split and join arity', async () => {
  let w = par(); w = dropEdge(w, 'sp', '*'); w.edges.push(edge('sp', 'a', '*')); await assertInvalid(w, 'sp', 'split with one target');
  w = par(); w.edges = w.edges.filter((e) => !(e.from === 'b' && e.to === 'j')); w.edges.push(edge('b', 'end', 'done')); await assertInvalid(w, 'j', 'join with one incoming');
  w = par(); w.edges.push(edge('j', 'end', '*')); await assertInvalid(w, 'j', 'join with two outgoing');
  w = par(); w.edges.push(edge('sp', 'a', 'done')); await assertInvalid(w, 'sp', 'split edge on something other than *');
  w = par(); w.edges.find((e) => e.from === 'j').on = 'done'; await assertInvalid(w, 'j', 'join edge on something other than *');
});

test('validate: exactly one start; everything reachable; an end reachable from everything', async () => {
  let w = mini(); w.nodes.push(node('t0'), node('t1', 'end')); w.edges.push(edge('t0', 't1', 'done')); await assertInvalid(w, null, 'a second start node');
  w = mini(); w.nodes.push(node('c1'), node('c2')); w.edges.push(edge('c1', 'c2', 'done'), edge('c2', 'c1', 'done')); await assertInvalid(w, null, 'an island cycle unreachable from the start');
  w = mini(); w = dropEdge(w, 'c', 'fail'); w.edges.push(edge('c', 's', 'fail')); w = dropEdge(w, 'p', 'done'); w.edges.push(edge('p', 's', 'done')); await assertInvalid(w, null, 'no end reachable');
  w = mini(); w.nodes.push(node('lost')); w.edges.push(edge('s', 'lost', 'regression')); await assertInvalid(w, 'lost', 'a dead-end non-end node');
  w = mini(); w.nodes = []; w.edges = []; await assertInvalid(w, null, 'empty graph');
  w = mini(); w.nodes = w.nodes.filter((n) => n.type !== 'end'); w.edges = w.edges.filter((e) => e.to !== 'end'); await assertInvalid(w, null, 'no end node');
});

test('validate: split and join must balance (nesting allowed)', async () => {
  let w = par(); w = without(w, 'j'); w.edges.push(edge('a', 'c', 'done'), edge('b', 'c', 'done')); await assertInvalid(w, 'sp', 'split whose branches never join');
  w = mini(); w.nodes.push(node('j', 'join')); w.edges = w.edges.filter((e) => !(e.from === 'c')); w.edges.push(edge('c', 'j', 'pass'), edge('c', 'j', 'fail'), edge('j', 'g', '*')); await assertInvalid(w, 'j', 'a join with no split');
  w = par(); w.nodes.push(node('d')); w.edges.push(edge('sp', 'd', '*'), edge('d', 'c', 'done')); await assertInvalid(w, null, 'one branch skips the join');
  w = par(); w.nodes.splice(w.nodes.findIndex((n) => n.id === 'a') + 1, 0, gate('ag')); w.edges = w.edges.filter((e) => !(e.from === 'a')); w.edges.push(edge('a', 'ag', 'done'), edge('ag', 'j', 'Go')); await assertInvalid(w, null, 'a gate inside a parallel branch');
  w = par(); w.edges.push(edge('a', 's', 'regression')); await assertInvalid(w, null, 'a branch loops back past the split');
  w = par(); w.edges = w.edges.map((e) => (e.from === 'c' && e.on === 'fail' ? { ...e, to: 'a' } : e)); await assertInvalid(w, 'a', 'a branch node entered from outside its region');
  w = par(); w.nodes.push(node('m')); w.edges = w.edges.filter((e) => !(e.from === 'a' && e.to === 'j')); w.edges.push(edge('a', 'm', 'done'), edge('m', 'j', 'done')); await assertValid(w, 'a longer branch is fine');
});

test('validate: nested split/join is valid', async () => {
  const w = wf(
    [node('s'), node('sp1', 'split'), node('a'), node('sp2', 'split'), node('b'), node('d'), node('j2', 'join'), node('m'), node('j1', 'join'), node('c', 'check', { runner: 'verifier' }), gate('g'), node('p', 'step', { pushes: true }), node('end', 'end')],
    [edge('s', 'sp1', 'done'), edge('sp1', 'a', '*'), edge('sp1', 'sp2', '*'), edge('sp2', 'b', '*'), edge('sp2', 'd', '*'), edge('b', 'j2', 'done'), edge('d', 'j2', 'done'),
      edge('j2', 'm', '*'), edge('a', 'j1', 'done'), edge('m', 'j1', 'done'), edge('j1', 'c', '*'), edge('c', 'g', 'pass'), edge('c', 'end', 'fail'), edge('g', 'p', 'Go'), edge('p', 'end', 'done')],
  );
  await assertValid(w, 'nested');
});

test('validate: maxRounds is an integer from 1 to 10', async () => {
  for (const bad of [0, 11, 2.5, '5', null, -1, NaN]) { const w = withFix(); w.loop.maxRounds = bad; await assertInvalid(w, null, `maxRounds ${String(bad)}`); }
  for (const good of [1, 5, 10]) { const w = withFix(); w.loop.maxRounds = good; await assertValid(w, `maxRounds ${good}`); }
});

test('validate: loop.decision must be an existing gate when a fixRound edge exists', async () => {
  let w = withFix(); w.loop.decision = 'nope'; await assertInvalid(w, 'nope', 'missing decision node');
  w = withFix(); w.loop.decision = 'fix'; await assertInvalid(w, 'fix', 'decision node is not a gate');
  w = mini(); w.loop.decision = 'nope'; await assertValid(w, 'no fixRound edge: loop.decision need not exist');
});

// ---- the push rule (AC5, AC14): a gate after the last check on EVERY path to a pushes node ----
test('push rule: a path from a check straight to the push is refused', async () => {
  let w = mini(); w = dropEdge(w, 'c', 'pass'); w.edges.push(edge('c', 'p', 'pass')); w = without(w, 'g'); await assertInvalid(w, 'p', 'check -> push with no gate');
  w = mini(); w.edges.push(edge('c', 'p', 'regression')); await assertInvalid(w, 'p', 'a second path check -> push that skips the gate');
});

test('push rule: a path with no check at all is refused', async () => {
  const w = wf([node('s'), gate('g'), node('p', 'step', { pushes: true }), node('end', 'end')], [edge('s', 'g', 'done'), edge('g', 'p', 'Go'), edge('p', 'end', 'done')]);
  await assertInvalid(w, 'p', 'gate but no check anywhere');
});

test('push rule: a gate BEFORE the check does not count', async () => {
  const w = wf([node('s'), gate('g0'), node('c', 'check', { runner: 'verifier' }), node('p', 'step', { pushes: true }), node('end', 'end')],
    [edge('s', 'g0', 'done'), edge('g0', 'c', 'Go'), edge('c', 'p', 'pass'), edge('c', 'end', 'fail'), edge('p', 'end', 'done')]);
  await assertInvalid(w, 'p', 'gate then check then push');
});

test('push rule: a check after the gate resets it', async () => {
  const w = wf([node('s'), node('c', 'check', { runner: 'verifier' }), gate('g'), node('c2', 'check', { runner: 'verifier' }), node('p', 'step', { pushes: true }), node('end', 'end')],
    [edge('s', 'c', 'done'), edge('c', 'g', 'pass'), edge('c', 'end', 'fail'), edge('g', 'c2', 'Go'), edge('c2', 'p', 'pass'), edge('c2', 'end', 'fail'), edge('p', 'end', 'done')]);
  await assertInvalid(w, 'p', 'check, gate, check, push');
});

test('push rule: allowed shapes', async () => {
  await assertValid(mini(), 'check, gate, push');
  let w = mini(); w.nodes.splice(3, 0, gate('g2')); w.edges = w.edges.map((e) => (e.from === 'g' ? { ...e, to: 'g2' } : e)); w.edges.push(edge('g2', 'p', 'Go')); await assertValid(w, 'two gates in a row');
  w = mini(); w.nodes[2].actions.push({ label: 'Back' }); w.edges.push(edge('g', 'c', 'Back')); await assertValid(w, 'a gate action that loops back to the check');
  w = withFix(); await assertValid(w, 'fix loop before the gate');
  w = par(); await assertValid(w, 'parallel work, then check, gate, push');
});

test('push rule: a fix loop whose exit skips the gate is refused', async () => {
  const w = withFix();
  w.edges = w.edges.map((e) => (e.from === 'fix' ? { ...e, to: 'p' } : e));
  await assertInvalid(w, 'p', 'fix -> push');
});

test('push rule: reaching the push through a parallel region still needs the gate', async () => {
  const w = wf(
    [node('s'), node('c', 'check', { runner: 'verifier' }), node('sp', 'split'), node('a'), node('b'), node('j', 'join'), node('p', 'step', { pushes: true }), node('end', 'end')],
    [edge('s', 'c', 'done'), edge('c', 'sp', 'pass'), edge('c', 'end', 'fail'), edge('sp', 'a', '*'), edge('sp', 'b', '*'), edge('a', 'j', 'done'), edge('b', 'j', 'done'), edge('j', 'p', '*'), edge('p', 'end', 'done')],
  );
  await assertInvalid(w, 'p', 'check, parallel pair, join, push (no gate)');
});

// ---- limits that keep validation cheap ----
test('validate: a huge graph does not overflow the stack or hang', async () => {
  const { validateWorkflow } = await W();
  const nodes = Array.from({ length: 20000 }, (_, i) => node(`n${i}`));
  const edges = nodes.slice(1).map((n, i) => edge(`n${i}`, n.id, 'done'));
  const t0 = Date.now();
  assert.doesNotThrow(() => validateWorkflow({ nodes, edges, loop: { maxRounds: 5, decision: 'decision' } }));
  assert.ok(Date.now() - t0 < 5000, 'validation took more than 5 s on 20000 nodes');
});
