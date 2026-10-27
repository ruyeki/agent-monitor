import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { seedWorkflow, normalizeWorkflow, validateWorkflow, fromSpine, matchEdge, OUTCOMES, NODE_TYPES } from '../src/workflow.js';
import { fixture } from './helpers.js';

const seed = () => seedWorkflow();
const node = (wf, id) => wf.nodes.find((n) => n.id === id);
const edgeOf = (wf, from, on) => wf.edges.find((e) => e.from === from && e.on === on);
const errorsFor = (mutate) => { const wf = seed(); mutate(wf); return validateWorkflow(wf); };
// An error whose message matches `re` and whose node/edge refs equal `ref`.
const has = (errors, re, ref = {}) => errors.some((e) => re.test(e.message) && Object.entries(ref).every(([k, v]) => e[k] === v));
const lines = (wf) => wf.edges.map((e) => `${e.from} -${e.on}-> ${e.to}${e.fixRound ? ' (fix)' : ''}`).sort();
const v1 = () => JSON.parse(fs.readFileSync(fixture('workflow-v1.json'), 'utf8'));

// Small graphs for the split/join rules.
const n = (id, type = 'step', extra = {}) => ({ id, type, name: id.toUpperCase(), runner: 'worker', model: 'sonnet', ...extra });
const e = (from, to, on = 'done', extra = {}) => ({ id: `${from}>${to}:${on}`, from, to, on, ...extra });
const graph = (nodes, edges) => ({ nodes, edges, loop: { maxRounds: 5, decision: 'decision' } });
const parallel = () => graph(
  [n('start'), n('s', 'split'), n('a'), n('b'), n('j', 'join'), n('end', 'end')],
  [e('start', 's'), e('s', 'a', '*'), e('s', 'b', '*'), e('a', 'j'), e('b', 'j'), e('j', 'end', '*')],
);

test('exports the outcomes and node types', () => {
  assert.deepEqual(OUTCOMES, ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck']);
  assert.deepEqual(NODE_TYPES, ['step', 'check', 'gate', 'split', 'join', 'end']);
});

test('AC2 seed nodes: ids, types, runners and models', () => {
  const want = {
    frame: ['step', 'main', 'inherit'], gate1: ['gate'], plan: ['step', 'lead', 'opus'], split: ['split'],
    implement: ['step', 'worker', 'sonnet'], prep: ['step', 'verifier', 'sonnet'], join: ['join'],
    verify: ['check', 'verifier', 'sonnet'], fix: ['step', 'worker', 'sonnet'], review: ['check', 'lead', 'inherit'],
    whitehat: ['check', 'white-hat', 'sonnet'], commit: ['step', 'lead'], report: ['step', 'lead'], gate2: ['gate'],
    pr: ['step', 'main', 'inherit'], decision: ['gate'], done: ['end'], stopped: ['end'],
  };
  const wf = seed();
  assert.deepEqual(wf.nodes.map((x) => x.id).sort(), Object.keys(want).sort());
  for (const [id, [type, runner, model]] of Object.entries(want)) {
    assert.equal(node(wf, id).type, type, id);
    if (runner) assert.equal(node(wf, id).runner, runner, id);
    if (model) assert.equal(node(wf, id).model, model, id);
  }
  assert.equal(node(wf, 'split').name, 'Parallel');
  assert.equal(node(wf, 'prep').name, 'Verifier prep');
  assert.deepEqual(wf.nodes.filter((x) => x.pushes).map((x) => x.id), ['pr']);
  assert.deepEqual(wf.loop, { maxRounds: 5, decision: 'decision' });
});

test('AC2 seed edges draw the real workflow', () => {
  assert.deepEqual(lines(seed()), [
    'commit -done-> report', 'decision -Resume-> plan', 'decision -Stop run-> stopped',
    'fix -done-> verify', 'frame -done-> gate1',
    'gate1 -Agree spec-> plan', 'gate1 -Stop run-> stopped',
    'gate2 -Accept-> pr', 'gate2 -Request changes-> plan', 'gate2 -Stop run-> stopped',
    'implement -done-> join', 'join -*-> verify', 'plan -done-> split', 'pr -done-> done', 'prep -done-> join',
    'report -done-> gate2', 'review -finding-> fix (fix)', 'review -pass-> whitehat',
    'split -*-> implement', 'split -*-> prep',
    'verify -env-> decision', 'verify -fail-> fix (fix)', 'verify -pass-> review', 'verify -regression-> decision', 'verify -stuck-> decision',
    'whitehat -finding-> fix (fix)', 'whitehat -pass-> commit',
  ].sort());
  for (const x of seed().edges) assert.equal(x.id, `${x.from}>${x.to}:${x.on}`);
});

test('AC2 seed gates ask and list their actions, all with a text field', () => {
  const wf = seed();
  const labels = (id) => node(wf, id).actions.map((a) => a.label);
  assert.equal(node(wf, 'gate1').ask, "What's your solution?");
  assert.deepEqual(labels('gate1'), ['Agree spec', 'Stop run']);
  assert.equal(node(wf, 'gate2').ask, 'Accept, push and open the PR?');
  assert.deepEqual(labels('gate2'), ['Accept', 'Request changes', 'Stop run']);
  assert.equal(node(wf, 'decision').ask, 'Decision needed');
  assert.deepEqual(labels('decision'), ['Resume', 'Stop run']);
  for (const g of wf.nodes.filter((x) => x.type === 'gate')) assert.equal(g.textField, true, g.id);
});

test('AC2 seed is valid, stable under normalize, and its work nodes say how to report', () => {
  const wf = seed();
  assert.deepEqual(validateWorkflow(wf), []);
  assert.deepEqual(normalizeWorkflow(wf), wf);
  assert.notEqual(seedWorkflow(), seedWorkflow());
  for (const x of wf.nodes.filter((y) => y.type === 'step' || y.type === 'check')) {
    assert.match(x.instructions, /complete_stage/, x.id);
    assert.ok(x.instructions.length < 450, x.id);
  }
  assert.match(node(wf, 'plan').instructions, /complete_stage returns implement and prep: run both together in the foreground, then report each with complete_stage\.$/);
  assert.match(node(wf, 'prep').instructions, /never edits product code/i);
  assert.ok(!/fable radar/i.test(JSON.stringify(wf)));
});

test('seed wording: frame stops at the problem card, plan tells the main session how to hand over', () => {
  const wf = seed();
  assert.match(node(wf, 'frame').instructions, /read-only/);
  assert.match(node(wf, 'frame').instructions, /problem card/);
  assert.doesNotMatch(node(wf, 'frame').instructions, /agree the spec with/i);
  assert.match(node(wf, 'plan').instructions, /^After Gate 1, write the agreed spec into the task and spawn the lead with RUN: <id> in its brief./);
});

test('normalize fills only missing keys and keeps wrong values for validation', () => {
  const wf = normalizeWorkflow({ nodes: [{ id: 'a', name: 'A', runner: 'worker' }, 'junk', { id: 'g', name: 'G', type: 'gate', ask: 'q', actions: [{ label: 'Ok', goto: 'x' }] }], edges: [{ id: 'x', from: 'a', to: 'g' }, 7] });
  assert.equal(wf.nodes.length, 2);
  const [a, g] = wf.nodes;
  assert.deepEqual([a.type, a.model, a.instructions, a.pushes, a.position], ['step', 'inherit', '', false, { x: 0, y: 0 }]);
  assert.equal('ask' in a, false);
  assert.deepEqual([g.textField, g.actions], [true, [{ label: 'Ok' }]]);
  assert.deepEqual(wf.edges, [{ id: 'x', from: 'a', to: 'g', on: undefined, fixRound: false }]);
  assert.deepEqual(wf.loop, { maxRounds: 5, decision: 'decision' });
  for (const bad of [null, '5', 0, 11]) assert.equal(normalizeWorkflow({ nodes: [], loop: { maxRounds: bad } }).loop.maxRounds, bad);
  assert.equal(normalizeWorkflow({ nodes: [{ id: 'a', model: null }] }).nodes[0].model, null);
  for (const junk of [undefined, null, 5, 'x', [], { nodes: 'x', edges: {} }]) {
    const out = normalizeWorkflow(junk);
    assert.deepEqual([out.nodes, out.edges], [[], []]);
  }
});

test('normalize does not mutate its input and turns a v1 spine into its graph', () => {
  const input = seed();
  const copy = structuredClone(input);
  normalizeWorkflow(input);
  assert.deepEqual(input, copy);
  assert.deepEqual(normalizeWorkflow(v1()), fromSpine(v1()));
});

test('AC3 fromSpine: the live v1 converts to a valid graph that behaves like v1', () => {
  const wf = fromSpine(v1());
  assert.deepEqual(validateWorkflow(wf), []);
  const stages = v1().stages.map((s) => s.id);
  assert.deepEqual(wf.nodes.map((x) => x.id), [...stages, 'fix', 'decision', 'done', 'stopped']);
  assert.deepEqual(['frame', 'verify', 'review', 'whitehat', 'gate1', 'fix', 'decision', 'done'].map((id) => node(wf, id).type),
    ['step', 'check', 'check', 'check', 'gate', 'step', 'gate', 'end']);
  const want = [
    'frame -pass-> gate1', 'frame -fail-> decision', 'frame -stuck-> decision',
    'gate1 -Agree spec-> plan', 'gate1 -Stop run-> stopped',
    'verify -pass-> review', 'verify -fail-> fix (fix)', 'verify -regression-> decision', 'verify -env-> decision',
    'gate2 -Accept-> pr', 'gate2 -Request changes-> plan', 'pr -pass-> done',
    'fix -pass-> verify', 'fix -fail-> decision', 'fix -env-> decision', 'decision -Resume-> plan', 'decision -Stop run-> stopped',
  ];
  for (const l of want) assert.ok(lines(wf).includes(l), l);
  assert.deepEqual([node(wf, 'fix').runner, node(wf, 'fix').model], ['worker', 'sonnet']);
  assert.equal(node(wf, 'pr').pushes, true);
  assert.deepEqual(wf.loop, { maxRounds: 5, decision: 'decision' });
  assert.deepEqual(node(wf, 'plan').position, { x: 440, y: 0 });
  assert.deepEqual(node(wf, 'done').position, { x: 11 * 220, y: 0 });
  assert.deepEqual(node(wf, 'fix').position, { x: 220, y: 190 });
  assert.deepEqual(node(wf, 'decision').position, { x: 550, y: 190 });
  assert.deepEqual(node(wf, 'stopped').position, { x: 10 * 220, y: 190 });
});

test('AC3 fromSpine honours onFail decision/continue and the loop settings', () => {
  const spine = v1();
  spine.stages.find((s) => s.id === 'verify').check.onFail = 'decision';
  spine.stages.find((s) => s.id === 'review').check.onFail = 'continue';
  Object.assign(spine.loop, { afterFix: 'review', resumeAt: 'implement', fixRunner: 'custom', fixModel: 'haiku', maxRounds: 3 });
  const wf = fromSpine(spine);
  for (const l of ['verify -fail-> decision', 'review -fail-> whitehat', 'whitehat -fail-> fix (fix)', 'fix -pass-> review', 'decision -Resume-> implement']) {
    assert.ok(lines(wf).includes(l), l);
  }
  assert.deepEqual([node(wf, 'fix').runner, node(wf, 'fix').model, wf.loop.maxRounds], ['custom', 'haiku', 3]);
  assert.deepEqual(validateWorkflow(wf), []);
});

test('edge matching: exact outcome, then its alias, then *', () => {
  const edges = [{ on: 'done', to: 'a' }, { on: 'finding', to: 'b' }, { on: '*', to: 'c' }];
  assert.equal(matchEdge(edges, 'done').to, 'a');
  assert.equal(matchEdge(edges, 'pass').to, 'a');
  assert.equal(matchEdge(edges, 'fail').to, 'b');
  assert.equal(matchEdge(edges, 'stuck').to, 'c');
  assert.equal(matchEdge([{ on: 'pass', to: 'x' }], 'regression'), null);
  assert.equal(matchEdge([{ on: 'pass', to: 'x' }, { on: 'done', to: 'y' }], 'done').to, 'y', 'exact beats alias');
});

test('AC5 rule 1: node ids, names, types, runners and models', () => {
  assert.ok(has(errorsFor((w) => { node(w, 'plan').id = 'Bad Id'; }), /'Bad Id' has an invalid id/, { node: 'Bad Id' }));
  assert.ok(has(errorsFor((w) => { node(w, 'plan').id = ''; }), /Node number \d+ has no id/));
  assert.ok(has(errorsFor((w) => { node(w, 'plan').id = 'frame'; }), /'frame' has an id that another node already uses/, { node: 'frame' }));
  assert.ok(has(errorsFor((w) => { node(w, 'plan').name = ' '; }), /'plan' has no name/, { node: 'plan' }));
  assert.ok(has(errorsFor((w) => { node(w, 'plan').type = 'robot'; }), /'plan' has an unknown type 'robot'/));
  assert.ok(has(errorsFor((w) => { node(w, 'verify').runner = 'robot'; }), /'verify' has an unknown runner 'robot'/, { node: 'verify' }));
  assert.ok(has(errorsFor((w) => { delete node(w, 'plan').runner; }), /'plan' has an unknown runner/));
  assert.ok(has(errorsFor((w) => { node(w, 'plan').model = 'gpt'; }), /'plan' has an unknown model 'gpt'/));
});

test('AC5 rule 1: fix, decision, done and stopped are ordinary ids', () => {
  const wf = seed();
  for (const [from, to] of [['fix', 'repair'], ['done', 'finished']]) {
    node(wf, from).id = to;
    for (const x of wf.edges) { if (x.from === from) x.from = to; if (x.to === from) x.to = to; }
  }
  assert.deepEqual(validateWorkflow(wf), []);
});

test('AC5 rule 1: gates need an ask and 1 to 10 actions with unique labels', () => {
  assert.ok(has(errorsFor((w) => { node(w, 'gate1').ask = ' '; }), /'gate1' is a gate and needs a question/, { node: 'gate1' }));
  assert.ok(has(errorsFor((w) => { node(w, 'gate1').actions = []; }), /'gate1' is a gate and needs from 1 to 10 actions/));
  assert.ok(has(errorsFor((w) => { node(w, 'gate1').actions = Array.from({ length: 11 }, (_, i) => ({ label: `a${i}` })); }), /from 1 to 10 actions/));
  assert.ok(has(errorsFor((w) => { node(w, 'gate1').actions.push({ label: '' }); }), /'gate1' has an action with no label/));
  assert.ok(has(errorsFor((w) => { node(w, 'gate1').actions.push({ label: 'agree SPEC' }); }), /'gate1' has two actions labelled 'agree SPEC'/));
});

test('AC5 rule 1: edge ids are unique and non-empty; ends must exist', () => {
  assert.ok(has(errorsFor((w) => { w.edges[0].id = ''; }), /Edge number 1 has no id/));
  assert.ok(has(errorsFor((w) => { w.edges[1].id = w.edges[0].id; }), /already uses/, { edge: 'frame>gate1:done' }));
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'commit', 'done').to = 'ghost'; }), /'commit>report:done' goes to 'ghost', which is not a node/, { edge: 'commit>report:done' }));
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'commit', 'done').from = 'ghost'; }), /starts at 'ghost'/));
});

test('AC5 rule 2: an edge says what its source can produce', () => {
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'commit', 'done').on = 'Accept'; }), /needs an outcome .* not 'Accept'/, { edge: 'commit>report:done' }));
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'gate1', 'Agree spec').on = 'pass'; }), /from gate 'gate1' must use one of its action labels, not 'pass'/));
  assert.ok(has(errorsFor((w) => { w.edges.find((x) => x.from === 'split').on = 'done'; }), /from split 'split' must use '\*'/));
  assert.ok(has(errorsFor((w) => { w.edges.push(e('done', 'frame', '*')); }), /leaves end node 'done'/, { edge: 'done>frame:*' }));
  assert.ok(has(errorsFor((w) => { w.edges.push(e('commit', 'pr', 'done', { id: 'dup' })); }), /'commit' has two edges for 'done'/, { edge: 'dup' }));
});

test('AC5 rule 3: every outcome a node can produce has an edge, or *', () => {
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'commit', 'done').on = 'fail'; }), /'commit' needs an edge for success/, { node: 'commit' }));
  assert.ok(has(errorsFor((w) => { w.edges = w.edges.filter((x) => x.id !== 'verify>fix:fail'); }), /Check 'verify' needs an edge for failure/, { node: 'verify' }));
  assert.deepEqual(errorsFor((w) => {
    w.edges = w.edges.filter((x) => x.id !== 'verify>fix:fail');
    w.edges.push(e('verify', 'fix', '*', { fixRound: true }));
  }), [], "'*' covers the failure");
  assert.ok(has(errorsFor((w) => { w.edges = w.edges.filter((x) => x.id !== 'gate1>stopped:Stop run'); }), /Gate 'gate1' action 'Stop run' needs exactly one edge/));
  assert.ok(has(errorsFor((w) => { w.edges = w.edges.filter((x) => x.id !== 'split>prep:*'); }), /Split 'split' needs at least two outgoing edges/));
  assert.ok(has(errorsFor((w) => { w.edges.push(e('split', 'prep', '*', { id: 'again' })); }), /Split 'split' needs at least two outgoing edges to different nodes/));
  assert.ok(has(errorsFor((w) => { w.edges.push(e('join', 'review', '*')); }), /Join 'join' needs exactly one outgoing edge/));
});

test('AC5 rule 4: one start node; everything reachable; an end reachable from everything', () => {
  assert.ok(has(errorsFor((w) => { w.nodes.push(n('orphan')); w.edges.push(e('orphan', 'plan')); }), /'orphan' has no incoming edges, but a workflow has only one start node/, { node: 'orphan' }));
  assert.ok(has(errorsFor((w) => { w.edges.push(e('gate2', 'frame', 'Stop run', { id: 'loop' })); w.edges = w.edges.filter((x) => x.id !== 'gate2>stopped:Stop run'); }), /needs a start node/));
  assert.ok(has(errorsFor((w) => { edgeOf(w, 'gate1', 'Agree spec').to = 'stopped'; }), /'plan' cannot be reached from the start node 'frame'/, { node: 'plan' }));
  const stuck = errorsFor((w) => {
    w.nodes.push(n('spin', 'check'));
    edgeOf(w, 'whitehat', 'pass').to = 'spin';
    w.edges.push(e('spin', 'spin', 'pass'), e('spin', 'commit', 'fail'));
  });
  assert.deepEqual(stuck, [], 'a loop with a way out is fine');
  assert.ok(has(errorsFor((w) => {
    w.nodes.push(n('spin'));
    edgeOf(w, 'whitehat', 'pass').to = 'spin';
    w.edges.push(e('spin', 'spin'));
  }), /'spin' cannot reach an end node/, { node: 'spin' }));
  assert.ok(has(validateWorkflow(graph([n('a')], [])), /needs at least one end node/));
});

test('AC5 rule 5: balanced split/join, nested pairs allowed', () => {
  assert.deepEqual(validateWorkflow(parallel()), []);
  const nested = graph(
    [n('start'), n('s1', 'split'), n('a'), n('s2', 'split'), n('b'), n('c'), n('j2', 'join'), n('d', 'check'), n('j1', 'join'), n('end', 'end')],
    [e('start', 's1'), e('s1', 'a', '*'), e('s1', 's2', '*'), e('s2', 'b', '*'), e('s2', 'c', '*'), e('b', 'j2'), e('c', 'j2'),
      e('j2', 'd', '*'), e('d', 'j1', 'pass'), e('d', 'b', 'fail'), e('a', 'j1'), e('j1', 'end', '*')],
  );
  assert.ok(has(validateWorkflow(nested), /enters a parallel branch of split 's2' from outside/, { edge: 'd>b:fail' }), 'a loop back into a finished inner branch');
  nested.edges = nested.edges.filter((x) => x.id !== 'd>b:fail');
  nested.edges.push(e('d', 'end', 'fail'));
  assert.deepEqual(validateWorkflow(nested), []);
});

test('AC5 rule 5: each way a split/join pair can be unbalanced', () => {
  const variant = (fn) => { const g = parallel(); fn(g); return validateWorkflow(g); };
  const add = (g, ...xs) => g.nodes.push(...xs);
  assert.ok(has(variant((g) => { g.edges.find((x) => x.id === 'a>j:done').to = 'end'; }), /Split 's' has a branch that never reaches a join/, { node: 's' }));
  assert.ok(has(variant((g) => {
    add(g, n('j2', 'join'));
    g.edges.find((x) => x.id === 'b>j:done').to = 'j2';
    g.edges.push(e('j2', 'end', '*'));
  }), /branches that meet at different joins \(j, j2\)/));
  assert.ok(has(variant((g) => {
    add(g, n('c'));
    g.edges = g.edges.filter((x) => !['a>j:done', 'b>j:done'].includes(x.id));
    g.edges.push(e('a', 'c'), e('b', 'c'), e('c', 'j'));
  }), /Split 's' has branches that share node 'c'/, { node: 'c' }));
  assert.ok(has(variant((g) => {
    g.nodes.find((x) => x.id === 'b').type = 'check';
    g.edges.push(e('b', 's', 'fail'));
  }), /A branch of split 's' loops back to the split/));
  assert.ok(has(variant((g) => {
    add(g, n('g', 'gate', { ask: 'ok?', actions: [{ label: 'Go' }] }));
    g.edges.find((x) => x.id === 'b>j:done').to = 'g';
    g.edges.push(e('g', 'j', 'Go'));
  }), /Gate 'g' sits inside a parallel branch of split 's'; gates can't sit inside parallel branches/, { node: 'g' }));
  assert.ok(has(variant((g) => {
    add(g, n('g', 'gate', { ask: 'ok?', actions: [{ label: 'Go' }] }));
    g.nodes.find((x) => x.id === 'a').type = 'check';
    g.edges.push(e('a', 'g', 'fail'), e('g', 'a', 'Go'));
  }), /Gate 'g' sits inside a parallel branch of split 's'/, { node: 'g' }), 'a gate off the success path');
  assert.ok(has(variant((g) => {
    g.nodes.find((x) => x.id === 'a').type = 'check';
    g.edges.push(e('a', 'j', 'fail'));
  }), /Join 'j' needs exactly one incoming edge from each branch of split 's'/, { node: 'j' }));
  assert.ok(has(validateWorkflow(graph(
    [n('start', 'check'), n('j', 'join'), n('end', 'end')],
    [e('start', 'j', 'pass'), e('start', 'j', 'fail'), e('j', 'end', '*')],
  )), /Join 'j' is not matched by any split/, { node: 'j' }));
  assert.ok(has(validateWorkflow(graph(
    [n('start', 'check'), n('s1', 'split'), n('s2', 'split'), n('a'), n('b'), n('c'), n('d'), n('j', 'join'), n('end', 'end')],
    [e('start', 's1', 'pass'), e('start', 's2', 'fail'), e('s1', 'a', '*'), e('s1', 'b', '*'), e('s2', 'c', '*'), e('s2', 'd', '*'),
      e('a', 'j'), e('b', 'j'), e('c', 'j'), e('d', 'j'), e('j', 'end', '*')],
  )), /Join 'j' is matched by more than one split \(s1, s2\)/));
});

test('AC5 rule 5: a branch may escalate to the decision gate or end the run', () => {
  const g = parallel();
  g.nodes.push(n('decision', 'gate', { ask: 'x', actions: [{ label: 'Stop run' }] }));
  g.nodes.find((x) => x.id === 'a').type = 'check';
  g.edges.push(e('a', 'decision', 'fail'), e('decision', 'end', 'Stop run'), e('b', 'end', 'stuck'));
  assert.deepEqual(validateWorkflow(g), []);
});

test('AC5 rule 6 + AC14: every path to a pushing node needs a gate after its last check', () => {
  const pushError = (errors) => has(errors, /'pr' pushes, but a path reaches it without a gate after its last check/, { node: 'pr' });
  assert.ok(pushError(errorsFor((w) => { edgeOf(w, 'fix', 'done').to = 'pr'; })), 'fix -> pr skips gate2');
  assert.ok(pushError(errorsFor((w) => { edgeOf(w, 'gate1', 'Agree spec').to = 'pr'; })), 'gate1 before any check does not count');
  assert.ok(pushError(errorsFor((w) => {
    node(w, 'gate1').actions.push({ label: 'Ship now' });
    w.edges.push(e('gate1', 'pr', 'Ship now'));
  })), 'an extra gate1 action straight to pr');
  assert.ok(pushError(errorsFor((w) => {
    edgeOf(w, 'verify', 'pass').to = 'gate2';
    edgeOf(w, 'gate2', 'Accept').to = 'review';
    edgeOf(w, 'report', 'done').to = 'pr';
  })), 'gate2 moved before the review and white-hat checks');
  assert.ok(pushError(errorsFor((w) => {
    w.nodes = w.nodes.filter((x) => x.id !== 'gate2');
    w.edges = w.edges.filter((x) => x.from !== 'gate2' && x.to !== 'gate2');
    w.edges.push(e('report', 'pr'));
  })), 'no gate after the checks at all');
  assert.ok(pushError(errorsFor((w) => { node(w, 'pr').type = 'check'; w.edges.push(e('pr', 'stopped', 'fail')); })), 'a pushing check');
  assert.ok(has(errorsFor((w) => { node(w, 'frame').pushes = true; }), /'frame' pushes/, { node: 'frame' }));
  assert.deepEqual(errorsFor((w) => { edgeOf(w, 'gate2', 'Accept').to = 'pr'; edgeOf(w, 'decision', 'Resume').to = 'verify'; }), []);
});

test('AC5 rule 7: maxRounds from 1 to 10; fix-round edges need a decision gate', () => {
  for (const [v, ok] of [[0, false], [11, false], [2.5, false], ['3', false], [null, false], [1, true], [10, true]]) {
    assert.equal(errorsFor((w) => { w.loop.maxRounds = v; }).length === 0, ok, String(v));
  }
  assert.ok(has(errorsFor((w) => { w.loop.decision = 'ghost'; }), /loop.decision 'ghost' to be a gate/));
  assert.ok(has(errorsFor((w) => { w.loop.decision = 'plan'; }), /loop.decision 'plan' to be a gate/, { node: 'plan' }));
  assert.deepEqual(validateWorkflow({ ...parallel(), loop: { maxRounds: 5, decision: 'nowhere' } }), [], 'no fix-round edge, no decision needed');
});

test('AC5 errors are one sentence each, as {message, node?, edge?}; garbage never throws', () => {
  const errors = errorsFor((w) => { node(w, 'implement').runner = 'robot'; node(w, 'whitehat').model = 'zz'; });
  assert.ok(errors.length >= 2);
  for (const x of errors) {
    assert.equal(typeof x.message, 'string');
    assert.match(x.message, /^[A-Z].*\.$/);
    assert.ok(Object.keys(x).every((k) => ['message', 'node', 'edge'].includes(k)), JSON.stringify(x));
  }
  for (const bad of [null, {}, { nodes: [] }, { nodes: [{}] }, { nodes: [null], edges: [null, {}] }, { nodes: [{ id: 'a', type: 'gate' }], edges: [{ from: 'a', to: 'a' }] }]) {
    let out;
    assert.doesNotThrow(() => { out = validateWorkflow(bad); });
    assert.ok(out.length >= 1);
  }
});

test('AC5 push rule also follows the engine hidden edge: a fixRound edge past maxRounds goes to loop.decision', () => {
  const gate = (id, labels) => n(id, 'gate', { ask: `${id}?`, actions: labels.map((label) => ({ label })) });
  const wf = graph(
    [n('a'), n('b'), n('c', 'check'), gate('gate2', ['Accept', 'Stop run']), n('pr', 'step', { runner: 'main', pushes: true }),
      gate('decision', ['Resume', 'Stop run']), n('done', 'end'), n('stopped', 'end')],
    [e('a', 'b', 'done', { fixRound: true }), e('b', 'c', 'done', { fixRound: true }),
      e('c', 'gate2', 'pass'), e('c', 'decision', 'fail'),
      e('gate2', 'pr', 'Accept'), e('gate2', 'stopped', 'Stop run'),
      e('decision', 'pr', 'Resume'), e('decision', 'stopped', 'Stop run'), e('pr', 'done')],
  );
  assert.ok(has(validateWorkflow(wf), /'pr' pushes/, { node: 'pr' }));
  wf.edges.forEach((x) => { x.fixRound = false; });
  assert.ok(!has(validateWorkflow(wf), /pushes/), 'without fix-round edges the decision gate is not reachable before a check');
  assert.deepEqual(validateWorkflow(seed()), [], 'the seed stays valid');
});
