import test from 'node:test';
import assert from 'node:assert/strict';
import { seedWorkflow, validateWorkflow } from '../src/workflow.js';
import * as engine from '../src/engine.js';

const wf = seedWorkflow();
const at = (active, extra = {}) => ({ active: [].concat(active), joins: {}, round: 0, status: 'active', verdict: null, ask: null, ...extra });
const complete = (state, stage, outcome, note, w = wf) => engine.completeStage(w, state, { stage, outcome, note });
const edge = (from, to, on, extra = {}) => ({ id: `${from}>${to}:${on}`, from, to, on, fixRound: false, ...extra });
// The seed with escalation edges from the parallel branches to the decision gate and to stopped.
const withEscalations = () => {
  const w = seedWorkflow();
  w.edges.push(edge('implement', 'decision', 'stuck'), edge('prep', 'stopped', 'env'));
  assert.deepEqual(validateWorkflow(w), []);
  return w;
};

test('start state: the start node is active', () => {
  assert.deepEqual(engine.startState(wf), at('frame'));
});

test('a gate as start node waits with its ask', () => {
  const w = seedWorkflow();
  w.nodes = w.nodes.filter((n) => n.id !== 'frame');
  w.edges = w.edges.filter((e) => e.from !== 'frame');
  const s = engine.startState(w);
  assert.deepEqual([s.active, s.status, s.ask], [['gate1'], 'waiting', "What's your solution?"]);
});

test('AC4 the seed walks to done, running implement and prep in parallel', () => {
  let s = engine.startState(wf);
  const seen = [s.active.join('+')];
  for (let i = 0; i < 30 && s.status !== 'done'; i++) {
    const r = s.status === 'waiting'
      ? engine.respond(wf, s, { action: wf.nodes.find((n) => n.id === s.active[0]).actions[0].label })
      : complete(s, s.active[0], 'pass');
    assert.ok(r.ok, r.error);
    s = r.state;
    seen.push(s.active.join('+') || s.status);
  }
  assert.deepEqual(seen, ['frame', 'gate1', 'plan', 'implement+prep', 'prep', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr', 'done']);
  assert.deepEqual([s.status, s.joins, s.ask], ['done', {}, null]);
});

test('AC4 a split activates all its targets; entered lists them (not the split)', () => {
  const r = complete(at('plan'), 'plan', 'done');
  assert.deepEqual([r.state.active, r.state.status, r.entered, r.left], [['implement', 'prep'], 'active', ['implement', 'prep'], ['plan']]);
});

test('AC4 a join continues only once every incoming branch has arrived, in either order', () => {
  for (const [first, second] of [['implement', 'prep'], ['prep', 'implement']]) {
    const one = complete(at(['implement', 'prep']), first, 'pass');
    assert.deepEqual(one.state.active, [second]);
    assert.deepEqual(one.state.joins, { join: [`${first}>join:done`] });
    assert.deepEqual([one.entered, one.left], [[], [first]]);
    const two = complete(one.state, second, 'done');
    assert.deepEqual([two.state.active, two.state.joins, two.entered, two.left], [['verify'], {}, ['verify'], [second]]);
  }
});

test('AC4 nested split/join pairs run and join correctly', () => {
  const n = (id, type = 'step') => ({ id, type, name: id, runner: 'worker', model: 'sonnet', instructions: '', pushes: false, position: { x: 0, y: 0 } });
  const w = {
    nodes: [n('start'), n('s1', 'split'), n('a'), n('s2', 'split'), n('b'), n('c'), n('j2', 'join'), n('d'), n('j1', 'join'), n('end', 'end')],
    edges: [edge('start', 's1', 'done'), edge('s1', 'a', '*'), edge('s1', 's2', '*'), edge('s2', 'b', '*'), edge('s2', 'c', '*'),
      edge('b', 'j2', 'done'), edge('c', 'j2', 'done'), edge('j2', 'd', '*'), edge('d', 'j1', 'done'), edge('a', 'j1', 'done'), edge('j1', 'end', '*')],
    loop: { maxRounds: 5, decision: 'decision' },
  };
  assert.deepEqual(validateWorkflow(w), []);
  let s = complete(engine.startState(w), 'start', 'pass', null, w).state;
  assert.deepEqual(s.active, ['a', 'b', 'c']);
  s = complete(s, 'b', 'pass', null, w).state;
  s = complete(s, 'a', 'pass', null, w).state;
  assert.deepEqual([s.active, s.joins], [['c'], { j2: ['b>j2:done'], j1: ['a>j1:done'] }]);
  s = complete(s, 'c', 'pass', null, w).state;
  assert.deepEqual([s.active, s.joins], [['d'], { j1: ['a>j1:done'] }]);
  const end = complete(s, 'd', 'pass', null, w);
  assert.deepEqual([end.state.status, end.state.active, end.state.joins, end.entered], ['done', [], {}, ['end']]);
});

test('AC4 completeStage errors, in order', () => {
  assert.equal(complete(at([], { status: 'done' }), 'pr', 'banana').error, 'Run is already done.');
  assert.equal(complete(at([], { status: 'stopped' }), 'pr', 'pass').error, 'Run is already stopped.');
  assert.match(complete(at('plan'), 'verify', 'banana').error, /^Unknown outcome 'banana'/);
  assert.equal(complete(at(['implement', 'prep']), 'verify', 'pass').error, "Stage 'verify' is not active. Active: implement, prep.");
  assert.equal(complete(at([]), 'verify', 'pass').error, "Stage 'verify' is not active. Active: none.");
  assert.equal(complete(at('gate1', { status: 'waiting' }), 'gate1', 'pass').error, "Run is waiting on Ryan at 'gate1'; use respond.");
  assert.equal(complete(at('decision', { status: 'waiting' }), 'decision', 'pass').error, "Run is waiting on Ryan at 'decision'; use respond.");
});

test('AC4 an outcome with no edge is refused and the error lists the valid outcomes', () => {
  assert.equal(complete(at(['implement', 'prep']), 'implement', 'regression').error,
    "No edge from 'implement' for outcome 'regression'. Valid outcomes: pass, done.");
  assert.match(complete(at('commit'), 'commit', 'fail').error, /Valid outcomes: pass, done\.$/);
  assert.deepEqual(engine.validOutcomes(wf, 'verify'), ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck']);
  assert.deepEqual(engine.validOutcomes(wf, 'review'), ['pass', 'done', 'fail', 'finding']);
  assert.equal(engine.validOutcomes(wf, 'join').length, 7, '* matches everything');
});

test('AC4 alias matching: pass/done and fail/finding, then *', () => {
  assert.deepEqual(complete(at('frame'), 'frame', 'pass').state.active, ['gate1'], 'pass follows a done edge');
  assert.deepEqual(complete(at('verify'), 'verify', 'done').state.active, ['review'], 'done follows a pass edge');
  assert.deepEqual(complete(at('review'), 'review', 'fail').state.active, ['fix'], 'fail follows a finding edge');
  assert.deepEqual(complete(at('verify'), 'verify', 'finding').state.active, ['fix'], 'finding follows a fail edge');
  const w = seedWorkflow();
  w.edges.push(edge('commit', 'decision', '*'));
  assert.deepEqual(complete(at('commit'), 'commit', 'stuck', 'hm', w).state.active, ['decision']);
  assert.deepEqual(complete(at('commit'), 'commit', 'done', 'hm', w).state.active, ['report'], 'an exact edge wins over *');
});

test('AC4 a fix-round edge adds a round; fix keeps it; past maxRounds goes to the decision with a note', () => {
  const r = complete(at('verify'), 'verify', 'fail', 'tests red');
  assert.deepEqual(r.state, at('fix', { round: 1, verdict: 'fail' }));
  assert.equal(complete(at('fix', { round: 2 }), 'fix', 'pass').state.round, 2);
  assert.deepEqual(complete(at('verify', { round: 4 }), 'verify', 'fail').state.round, 5);
  const d = complete(at('verify', { round: 5 }), 'verify', 'fail', 'still red');
  assert.deepEqual([d.state.active, d.state.status, d.state.round, d.state.ask], [['decision'], 'waiting', 5, 'still red (fix round limit 5 reached)']);
  assert.equal(complete(at('whitehat', { round: 5 }), 'whitehat', 'finding').state.ask, 'Checks failed (fix round limit 5 reached)');
  const w = seedWorkflow();
  w.loop.maxRounds = 1;
  assert.deepEqual(complete(at('review', { round: 1 }), 'review', 'finding', 'x', w).state.active, ['decision']);
});

test('AC4 entering the decision gate asks the note, or the gate ask', () => {
  const r = complete(at('verify'), 'verify', 'regression', 'broke login');
  assert.deepEqual([r.state.active, r.state.status, r.state.ask, r.state.verdict], [['decision'], 'waiting', 'broke login', 'regression']);
  assert.equal(complete(at('verify'), 'verify', 'env').state.ask, 'Decision needed');
});

test('AC4 the decision gate cancels every parallel branch and pending join', () => {
  const w = withEscalations();
  const r = complete(at(['implement', 'prep']), 'implement', 'stuck', 'blocked', w);
  assert.deepEqual([r.state.active, r.state.joins, r.state.status, r.state.ask], [['decision'], {}, 'waiting', 'blocked']);
  assert.deepEqual([r.entered, r.left], [['decision'], ['implement', 'prep']]);
  const half = complete(at(['implement', 'prep']), 'prep', 'pass', null, w).state;
  assert.deepEqual(half.joins, { join: ['prep>join:done'] });
  assert.deepEqual(complete(half, 'implement', 'stuck', 'x', w).state.joins, {});
});

test('AC4 an end node reached from one branch ends the whole run', () => {
  const r = complete(at(['implement', 'prep']), 'prep', 'env', null, withEscalations());
  assert.deepEqual([r.state.status, r.state.active, r.entered, r.left], ['stopped', [], ['stopped'], ['prep', 'implement']]);
});

test('AC4 stop ends every branch', () => {
  const s = engine.stop(at(['implement', 'prep'], { joins: { join: ['x'] }, round: 2, ask: 'q' }));
  assert.deepEqual(s, { active: [], joins: {}, round: 2, status: 'stopped', verdict: null, ask: null });
});

test('AC4 respond: trimmed, case-insensitive label; follows the action edge; every answer resets the round', () => {
  const g2 = at('gate2', { status: 'waiting', ask: 'x', round: 3 });
  const r = engine.respond(wf, g2, { action: '  request CHANGES ', text: 'more tests' });
  assert.deepEqual(r.answer, { action: 'Request changes', text: 'more tests' });
  assert.deepEqual([r.state.active, r.state.round, r.state.status, r.state.ask], [['plan'], 0, 'active', null]);
  assert.deepEqual([r.entered, r.left], [['plan'], ['gate2']]);
  assert.deepEqual(engine.respond(wf, g2, { action: 'Accept' }).state.active, ['pr']);
  const stop = engine.respond(wf, g2, { action: 'Stop run' });
  assert.deepEqual([stop.state.status, stop.state.active, stop.entered], ['stopped', [], ['stopped']]);
  assert.equal(engine.respond(wf, at('gate1', { status: 'waiting' }), { action: 'agree spec' }).answer.text, '');
});

test('AC4 respond at the decision: Resume goes to plan with rounds reset; Stop run stops', () => {
  const d = at('decision', { status: 'waiting', ask: 'x', round: 5 });
  const r = engine.respond(wf, d, { action: 'resume', text: 'go on' });
  assert.deepEqual([r.state.active, r.state.round, r.state.status], [['plan'], 0, 'active']);
  assert.equal(engine.respond(wf, d, { action: 'Stop run' }).state.status, 'stopped');
});

test('respond errors: unknown label lists the real ones; not waiting', () => {
  assert.equal(engine.respond(wf, at('gate2', { status: 'waiting' }), { action: 'Maybe' }).error, "Unknown action 'Maybe'. Use one of: Accept, Request changes, Stop run.");
  assert.match(engine.respond(wf, at('plan'), { action: 'Accept' }).error, /not waiting/);
  assert.match(engine.respond(wf, at([], { status: 'done' }), { action: 'Accept' }).error, /not waiting/);
});

test('the engine is pure: inputs are never changed', () => {
  const w = structuredClone(wf);
  const s = at(['implement', 'prep'], { joins: {} });
  const copy = structuredClone(s);
  complete(s, 'implement', 'pass', null, w);
  engine.respond(w, at('gate1', { status: 'waiting' }), { action: 'Agree spec' });
  engine.stop(s);
  assert.deepEqual(s, copy);
  assert.deepEqual(w, wf);
});

test('describeNode: steps, checks, gates (with the live ask) and unknown ids', () => {
  assert.deepEqual(engine.describeNode(wf, 'plan'), {
    id: 'plan', name: 'Plan', type: 'step', runner: 'lead', model: 'opus', instructions: wf.nodes.find((n) => n.id === 'plan').instructions,
  });
  assert.equal(engine.describeNode(wf, 'verify').type, 'check');
  const gate = engine.describeNode(wf, 'gate2');
  assert.deepEqual([gate.ask, gate.actions, gate.textField], ['Accept, push and open the PR?', [{ label: 'Accept' }, { label: 'Request changes' }, { label: 'Stop run' }], true]);
  assert.equal(engine.describeNode(wf, 'decision', at('decision', { status: 'waiting', ask: 'pick one' })).ask, 'pick one');
  assert.equal(engine.describeNode(wf, 'decision', at('plan', { ask: 'stale' })).ask, 'Decision needed');
  assert.equal(engine.describeNode(wf, 'nope'), null);
});
