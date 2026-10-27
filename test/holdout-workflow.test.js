import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load } from './holdout-helpers.js';

const W = await load('src/workflow.js').catch((e) => { throw new Error('cannot load src/workflow.js: ' + e.message); });
const seed = () => structuredClone(W.seedWorkflow());
const node = (wf, id) => wf.nodes.find((s) => s.id === id);
const edgeOf = (wf, from, on) => wf.edges.find((e) => e.from === from && e.on === on);
const errs = (wf) => W.validateWorkflow(wf);
const mentions = (list, ...needles) => list.some((e) => needles.every((n) => e.message.toLowerCase().includes(String(n).toLowerCase())));
// Renames a node and every edge end that points at it.
const rename = (wf, from, to) => {
  node(wf, from).id = to;
  for (const e of wf.edges) { if (e.from === from) e.from = to; if (e.to === from) e.to = to; }
};

// ---- AC1: exports + normalize defaults
test('AC1 exports constants', () => {
  assert.deepEqual([...W.OUTCOMES], ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck']);
  assert.deepEqual([...W.NODE_TYPES], ['step', 'check', 'gate', 'split', 'join', 'end']);
  for (const r of ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom']) assert.ok(W.RUNNERS.includes(r), r);
  for (const m of ['inherit', 'haiku', 'sonnet', 'opus', 'fable']) assert.ok(W.MODELS.includes(m), m);
  assert.equal(W.SYNTHETIC, undefined, 'no reserved ids any more');
});

test('AC1 normalize fills loop defaults when loop is missing or partial', () => {
  const a = W.normalizeWorkflow({ nodes: [{ id: 'a', name: 'A', type: 'step', runner: 'main' }] });
  assert.deepEqual(a.loop, { maxRounds: 5, decision: 'decision' });
  const b = W.normalizeWorkflow({ nodes: [], loop: { maxRounds: 3 } });
  assert.equal(b.loop.maxRounds, 3);
  assert.equal(b.loop.decision, 'decision');
});

test('AC1 normalize fills node and edge defaults', () => {
  const n = W.normalizeWorkflow({ nodes: [{ id: 'a', name: 'A', runner: 'worker' }], edges: [{ id: 'e', from: 'a', to: 'a', on: 'pass' }] });
  const s = n.nodes[0];
  assert.equal(s.type, 'step');
  assert.equal(s.model, 'inherit');
  assert.equal(s.pushes, false);
  assert.equal(typeof s.instructions, 'string');
  assert.deepEqual(s.position, { x: 0, y: 0 });
  assert.equal(n.edges[0].fixRound, false);
});

test('AC1 normalize fills gate defaults and keeps given values', () => {
  const n = W.normalizeWorkflow({ nodes: [
    { id: 'g', name: 'G', type: 'gate' },
    { id: 'c', name: 'C', type: 'check', runner: 'verifier', model: 'opus', pushes: true, instructions: 'hi', position: { x: 5, y: 6 } },
  ] });
  const g = n.nodes[0];
  assert.ok(Array.isArray(g.actions));
  assert.equal(typeof g.ask, 'string');
  assert.equal(g.textField, true);
  const c = n.nodes[1];
  assert.equal(c.type, 'check');
  assert.equal(c.model, 'opus');
  assert.equal(c.pushes, true);
  assert.equal(c.instructions, 'hi');
  assert.deepEqual(c.position, { x: 5, y: 6 });
  assert.equal('actions' in c, false, 'gate fields only on gates');
});

test('AC1 normalize tolerates garbage and does not throw', () => {
  for (const bad of [undefined, null, {}, { nodes: 'x' }, { nodes: [null, 1], edges: [null, 'x'] }]) {
    let out;
    assert.doesNotThrow(() => { out = W.normalizeWorkflow(bad); });
    assert.ok(out && Array.isArray(out.nodes) && Array.isArray(out.edges));
    assert.ok(out.loop && out.loop.maxRounds);
  }
});

test('AC1 normalize does not mutate its input', () => {
  const input = { nodes: [{ id: 'a', name: 'A', type: 'step', runner: 'main' }], edges: [] };
  const copy = structuredClone(input);
  W.normalizeWorkflow(input);
  assert.deepEqual(input, copy);
});

// ---- AC2: seed graph
test('AC2 seed order, types, runners, models', () => {
  const wf = seed();
  assert.deepEqual(wf.nodes.map((s) => s.id).slice(0, 4), ['frame', 'gate1', 'plan', 'split']);
  const spec = {
    frame: ['step', 'main', 'inherit'], gate1: ['gate'], plan: ['step', 'lead', 'opus'],
    implement: ['step', 'worker', 'sonnet'], prep: ['step', 'verifier', 'sonnet'], verify: ['check', 'verifier', 'sonnet'],
    review: ['check', 'lead', 'inherit'], whitehat: ['check', 'white-hat', 'sonnet'], fix: ['step', 'worker', 'sonnet'],
    commit: ['step', 'lead'], report: ['step', 'lead'], gate2: ['gate'], pr: ['step', 'main', 'inherit'],
    decision: ['gate'], done: ['end'], stopped: ['end'], split: ['split'], join: ['join'],
  };
  for (const [id, [type, runner, model]] of Object.entries(spec)) {
    const s = node(wf, id);
    assert.equal(s.type, type, id + ' type');
    if (runner) assert.equal(s.runner, runner, id + ' runner');
    if (model) assert.equal(s.model, model, id + ' model');
  }
});

test('AC2 seed checks, fix rounds, pushes, loop', () => {
  const wf = seed();
  assert.deepEqual(wf.nodes.filter((s) => s.type === 'check').map((s) => s.id), ['verify', 'review', 'whitehat']);
  assert.deepEqual(wf.edges.filter((e) => e.fixRound).map((e) => `${e.from}->${e.to}`), ['verify->fix', 'review->fix', 'whitehat->fix']);
  assert.deepEqual(wf.nodes.filter((s) => s.pushes).map((s) => s.id), ['pr']);
  assert.deepEqual(wf.loop, { maxRounds: 5, decision: 'decision' });
});

test('AC2 seed gates ask and actions, and where each action goes', () => {
  const wf = seed();
  const to = (gate) => node(wf, gate).actions.map((a) => [a.label, wf.edges.find((e) => e.from === gate && e.on === a.label).to]);
  assert.equal(node(wf, 'gate1').ask, "What's your solution?");
  assert.deepEqual(to('gate1'), [['Agree spec', 'plan'], ['Stop run', 'stopped']]);
  assert.equal(node(wf, 'gate1').textField, true);
  assert.equal(node(wf, 'gate2').ask, 'Accept, push and open the PR?');
  assert.deepEqual(to('gate2'), [['Accept', 'pr'], ['Request changes', 'plan'], ['Stop run', 'stopped']]);
  assert.equal(node(wf, 'gate2').textField, true);
  assert.deepEqual(to('decision'), [['Resume', 'plan'], ['Stop run', 'stopped']]);
});

test('AC2 seed every node has a name, work nodes have instructions; seed validates and is stable', () => {
  const wf = seed();
  for (const s of wf.nodes) {
    assert.ok(s.name && s.name.trim(), s.id + ' name');
    if (s.type === 'step' || s.type === 'check') assert.ok(s.instructions && s.instructions.trim().length > 10, s.id + ' instructions');
  }
  assert.deepEqual(errs(wf), []);
  assert.deepEqual(W.validateWorkflow(W.normalizeWorkflow(wf)), []);
  assert.deepEqual(W.normalizeWorkflow(wf), wf, 'normalize of the seed is a no-op');
  assert.notEqual(W.seedWorkflow(), W.seedWorkflow(), 'seedWorkflow returns a fresh object each call');
});

test('AC2 seed never mentions the old product name', () => {
  assert.ok(!/fable radar/i.test(JSON.stringify(W.seedWorkflow())));
});

// ---- AC5: validation rules
test('AC5 duplicate and empty ids', () => {
  let wf = seed(); node(wf, 'plan').id = 'frame';
  assert.ok(mentions(errs(wf), 'frame'), 'dup id names the node');
  wf = seed(); node(wf, 'plan').id = '';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); node(wf, 'plan').id = '   ';
  assert.ok(errs(wf).length >= 1);
});

test('AC5 id pattern', () => {
  for (const bad of ['Bad', '1abc', 'has space', '-x', '_x', 'a.b', 'a/b']) {
    const wf = seed(); rename(wf, 'plan', bad);
    assert.ok(errs(wf).length >= 1, 'id ' + JSON.stringify(bad) + ' should be rejected');
  }
  for (const ok of ['a', 'a1', 'a-b_c9', 'x'.repeat(40)]) {
    const wf = seed(); rename(wf, 'plan', ok);
    assert.deepEqual(errs(wf), [], 'id ' + ok + ' should be valid');
  }
});

test('AC5 the old reserved ids are ordinary now; a clash is still a duplicate', () => {
  for (const id of ['next', 'stop']) {
    const wf = seed(); rename(wf, 'plan', id);
    assert.deepEqual(errs(wf), [], id);
  }
  for (const id of ['fix', 'decision', 'done', 'stopped']) {
    const wf = seed(); node(wf, 'plan').id = id;
    assert.ok(mentions(errs(wf), id, 'already uses'), id);
  }
});

test('AC5 empty name, bad runner, bad model', () => {
  let wf = seed(); node(wf, 'plan').name = '';
  assert.ok(mentions(errs(wf), 'plan'));
  wf = seed(); node(wf, 'plan').name = '  ';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); node(wf, 'implement').runner = 'robot';
  assert.ok(mentions(errs(wf), 'implement'));
  wf = seed(); delete node(wf, 'implement').runner;
  assert.ok(mentions(errs(wf), 'implement'));
  wf = seed(); node(wf, 'implement').model = 'gpt';
  assert.ok(mentions(errs(wf), 'implement'));
});

test('AC5 gate rules: ask, actions, one edge per action to a real node', () => {
  let wf = seed(); node(wf, 'gate1').ask = '';
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); node(wf, 'gate1').ask = '   ';
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); node(wf, 'gate1').actions = [];
  assert.ok(mentions(errs(wf), 'gate1'));
  wf = seed(); edgeOf(wf, 'gate2', 'Request changes').to = 'nowhere';
  assert.ok(mentions(errs(wf), 'nowhere'));
  wf = seed(); edgeOf(wf, 'gate2', 'Request changes').to = 'verify';
  assert.deepEqual(errs(wf), [], 'an action to an existing node is valid');
  wf = seed(); wf.edges = wf.edges.filter((e) => !(e.from === 'gate1' && e.on === 'Stop run'));
  assert.ok(mentions(errs(wf), 'gate1', 'Stop run'), 'every action needs its edge');
});

test('AC5 check failure edges and the loop decision', () => {
  let wf = seed(); Object.assign(edgeOf(wf, 'verify', 'fail'), { on: 'explode' });
  assert.ok(mentions(errs(wf), 'verify'));
  wf = seed(); Object.assign(edgeOf(wf, 'verify', 'fail'), { to: 'review', fixRound: false });
  assert.deepEqual(errs(wf), [], 'a failure may continue');
  wf = seed(); Object.assign(edgeOf(wf, 'verify', 'fail'), { to: 'decision', fixRound: false });
  assert.deepEqual(errs(wf), [], 'a failure may go straight to the decision');
  wf = seed(); wf.loop.decision = 'ghost';
  assert.ok(errs(wf).length >= 1);
  wf = seed(); wf.loop.decision = 'fix';
  assert.ok(errs(wf).length >= 1, 'loop.decision must be a gate');
});

test('AC5 a pushing workflow with no check at all is refused', () => {
  const wf = seed();
  for (const id of ['verify', 'review', 'whitehat']) node(wf, id).type = 'step';
  assert.ok(mentions(errs(wf), 'pr', 'pushes'));
});

test('AC5 maxRounds boundaries', () => {
  for (const [v, ok] of [[0, false], [11, false], [-1, false], [1.5, false], ['5', false], [null, false], [1, true], [10, true], [5, true]]) {
    const wf = seed(); wf.loop.maxRounds = v;
    const e = errs(wf);
    assert.equal(e.length === 0, ok, 'maxRounds ' + JSON.stringify(v) + ' -> ' + e.map((x) => x.message).join(' | '));
  }
});

test('AC5 a pushing node needs a gate before it', () => {
  // gate2 moved after pr: report -> pr -> gate2 -> done
  const wf = seed();
  edgeOf(wf, 'report', 'done').to = 'pr';
  edgeOf(wf, 'pr', 'done').to = 'gate2';
  edgeOf(wf, 'gate2', 'Accept').to = 'done';
  const e = errs(wf);
  assert.ok(e.length >= 1);
  assert.ok(mentions(e, 'pr'), 'error names the pushing node: ' + e.map((x) => x.message).join(' | '));
});

test('AC5 no gate at all before a pushing node', () => {
  const wf = seed();
  wf.nodes = wf.nodes.filter((s) => s.id !== 'gate2');
  wf.edges = wf.edges.filter((e) => e.from !== 'gate2' && e.to !== 'gate2');
  wf.edges.push({ id: 'report>pr:done', from: 'report', to: 'pr', on: 'done' });
  assert.ok(mentions(errs(wf), 'pr'), 'gate1 sits before every check, so it cannot guard the push');
});

test('AC5 the gate before a pushing node must come after every check', () => {
  const wf = seed();
  edgeOf(wf, 'verify', 'pass').to = 'gate2'; // gate now sits between verify and review
  edgeOf(wf, 'gate2', 'Accept').to = 'review';
  edgeOf(wf, 'report', 'done').to = 'pr';
  const e = errs(wf);
  assert.ok(e.length >= 1, 'gate before the review/whitehat checks does not guard the push');
  assert.ok(mentions(e, 'pr'), e.map((x) => x.message).join(' | '));
});

test('AC5 valid minimal workflow: check, gate after it, push after the gate', () => {
  const n = (id, type, extra = {}) => ({ id, type, name: id, runner: 'worker', model: 'sonnet', ...extra });
  const e = (from, to, on) => ({ id: `${from}>${to}:${on}`, from, to, on });
  const nodes = [
    n('build', 'check'), n('ok', 'gate', { ask: 'Ship?', actions: [{ label: 'Yes' }, { label: 'No' }], textField: false }),
    n('ship', 'step', { pushes: true }), n('done', 'end'), n('stopped', 'end'),
  ];
  const wf = { nodes, edges: [e('build', 'ok', 'pass'), e('build', 'stopped', 'fail'), e('ok', 'ship', 'Yes'), e('ok', 'stopped', 'No'), e('ship', 'done', 'done')], loop: { maxRounds: 3 } };
  assert.deepEqual(errs(wf), []);
  // the push first, then the check and the gate
  wf.edges = [e('ship', 'build', 'done'), e('build', 'ok', 'pass'), e('build', 'stopped', 'fail'), e('ok', 'done', 'Yes'), e('ok', 'stopped', 'No')];
  assert.ok(mentions(errs(wf), 'ship'));
});

test('AC5 errors are human sentences naming the node', () => {
  const wf = seed(); node(wf, 'implement').runner = 'robot'; node(wf, 'whitehat').model = 'zz';
  const e = errs(wf);
  assert.ok(Array.isArray(e) && e.every((x) => typeof x.message === 'string' && x.message.length > 8));
  assert.ok(mentions(e, 'implement') && mentions(e, 'whitehat'));
  assert.ok(e.some((x) => x.node === 'implement') && e.some((x) => x.node === 'whitehat'));
});

test('AC5 validate does not throw on garbage', () => {
  for (const bad of [{}, { nodes: [] }, { nodes: [{}] }, { nodes: [null] }, { stages: [{}] }]) {
    let e; assert.doesNotThrow(() => { e = errs(bad); });
    assert.ok(e.length >= 1);
  }
});
