// Holdout: web/src/editor/model.js (pure graph edits) and web/src/lib/layout.js (autoLayout), AC7. Vitest.
import { describe, expect, it } from 'vitest';

const M = () => import('../src/editor/model.js');
const L = () => import('../src/lib/layout.js');

const node = (id, type = 'step', extra = {}) => ({ id, type, name: id, runner: 'worker', model: 'inherit', instructions: '', position: { x: 0, y: 0 }, ...extra });
const gate = (id, labels) => node(id, 'gate', { ask: 'q', actions: labels.map((label) => ({ label })), textField: true });
const sample = () => ({
  nodes: [node('a'), node('c', 'check'), gate('g', ['Yes', 'No']), node('sp', 'split'), node('j', 'join'), node('end', 'end')],
  edges: [{ id: 'a>c:done', from: 'a', to: 'c', on: 'done' }, { id: 'c>g:pass', from: 'c', to: 'g', on: 'pass' }],
  loop: { maxRounds: 5, decision: 'g' },
});
const frozen = (wf) => JSON.stringify(wf);

describe('model.addNode', () => {
  it('adds a node of the type at the position, without mutating the input', async () => {
    const { addNode } = await M();
    const wf = sample(); const before = frozen(wf);
    const out = addNode(wf, 'step', { x: 120, y: 80 });
    expect(frozen(wf)).toBe(before);
    expect(out.nodes).toHaveLength(wf.nodes.length + 1);
    const n = out.nodes.at(-1);
    expect(n.type).toBe('step');
    expect(n.position).toEqual({ x: 120, y: 80 });
    expect(typeof n.name).toBe('string');
    expect(n.name.length).toBeGreaterThan(0);
    expect(n.id).toMatch(/^[a-z][a-z0-9_-]*$/);
    expect(out.edges).toEqual(wf.edges);
  });

  it('gives every new node a unique valid id, also for the same type repeatedly', async () => {
    const { addNode } = await M();
    let wf = sample();
    for (let i = 0; i < 6; i++) wf = addNode(wf, 'step', { x: i, y: i });
    const ids = wf.nodes.map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every palette type works; a gate comes with an ask and at least one action; runner and model are valid', async () => {
    const { addNode } = await M();
    for (const type of ['step', 'check', 'gate', 'split', 'join', 'end']) {
      const n = addNode(sample(), type, { x: 0, y: 0 }).nodes.at(-1);
      expect(n.type).toBe(type);
      if (type === 'gate') {
        expect(n.ask.length).toBeGreaterThan(0);
        expect(n.actions.length).toBeGreaterThanOrEqual(1);
        expect(n.actions.every((a) => a.label)).toBe(true);
      }
      if (type === 'step' || type === 'check') {
        expect(['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom']).toContain(n.runner);
        expect(['inherit', 'haiku', 'sonnet', 'opus', 'fable']).toContain(n.model);
      }
    }
  });
});

describe('model.removeNode', () => {
  it('drops the node and every edge into or out of it', async () => {
    const { removeNode } = await M();
    const wf = sample(); const before = frozen(wf);
    const out = removeNode(wf, 'c');
    expect(frozen(wf)).toBe(before);
    expect(out.nodes.map((n) => n.id)).not.toContain('c');
    expect(out.edges).toEqual([]);
  });
  it('an unknown id changes nothing', async () => {
    const { removeNode } = await M();
    expect(removeNode(sample(), 'zzz')).toEqual(sample());
  });
});

describe('model.connect', () => {
  it('default on: step done; check pass then fail; gate its first free action; split and join *', async () => {
    const { connect } = await M();
    let wf = sample();
    wf = connect(wf, 'sp', 'a');
    expect(wf.edges.at(-1)).toMatchObject({ from: 'sp', to: 'a', on: '*' });
    wf = connect(wf, 'j', 'end');
    expect(wf.edges.at(-1).on).toBe('*');
    const base = { ...sample(), edges: [] };
    expect(connect(base, 'a', 'c').edges[0].on).toBe('done');
    let c = connect(base, 'c', 'a');
    expect(c.edges[0].on).toBe('pass');
    c = connect(c, 'c', 'end');
    expect(c.edges.at(-1).on).toBe('fail');
    let g = connect(base, 'g', 'a');
    expect(g.edges[0].on).toBe('Yes');
    g = connect(g, 'g', 'end');
    expect(g.edges.at(-1).on).toBe('No');
  });

  it('an explicit on wins; ids follow from>to:on and stay unique; the input is not mutated', async () => {
    const { connect } = await M();
    const wf = { ...sample(), edges: [] }; const before = frozen(wf);
    const out = connect(wf, 'a', 'end', 'stuck');
    expect(frozen(wf)).toBe(before);
    expect(out.edges[0]).toMatchObject({ id: 'a>end:stuck', from: 'a', to: 'end', on: 'stuck' });
    const twice = connect(connect(out, 'c', 'end', 'pass'), 'c', 'end', 'pass');
    const ids = twice.edges.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('model.removeEdge / patchNode / patchEdge', () => {
  it('removeEdge drops one edge', async () => {
    const { removeEdge } = await M();
    const out = removeEdge(sample(), 'c>g:pass');
    expect(out.edges.map((e) => e.id)).toEqual(['a>c:done']);
  });
  it('patchNode merges fields into one node only', async () => {
    const { patchNode } = await M();
    const wf = sample(); const before = frozen(wf);
    const out = patchNode(wf, 'a', { name: 'Renamed', model: 'opus', pushes: true, position: { x: 5, y: 6 } });
    expect(frozen(wf)).toBe(before);
    expect(out.nodes.find((n) => n.id === 'a')).toMatchObject({ name: 'Renamed', model: 'opus', pushes: true, position: { x: 5, y: 6 }, runner: 'worker' });
    expect(out.nodes.find((n) => n.id === 'c')).toEqual(wf.nodes.find((n) => n.id === 'c'));
  });
  it('patchEdge changes on and fixRound of one edge', async () => {
    const { patchEdge } = await M();
    const out = patchEdge(sample(), 'c>g:pass', { on: 'fail', fixRound: true });
    expect(out.edges.find((e) => e.id === 'c>g:pass')).toMatchObject({ on: 'fail', fixRound: true, from: 'c', to: 'g' });
    expect(out.edges.find((e) => e.id === 'a>c:done').on).toBe('done');
  });
});

describe('model.renameNode', () => {
  it('rewrites the node, every edge end and loop.decision', async () => {
    const { renameNode } = await M();
    const wf = sample(); const before = frozen(wf);
    const out = renameNode(wf, 'g', 'ryan');
    expect(frozen(wf)).toBe(before);
    expect(out.nodes.map((n) => n.id)).toContain('ryan');
    expect(out.nodes.map((n) => n.id)).not.toContain('g');
    expect(out.edges.find((e) => e.id === 'c>g:pass').to).toBe('ryan');
    expect(out.loop.decision).toBe('ryan');
    const src = renameNode(wf, 'a', 'start');
    expect(src.edges[0].from).toBe('start');
    expect(src.loop.decision).toBe('g');
  });
});

describe('layout.autoLayout', () => {
  const chain = () => ({ nodes: ['a', 'b', 'c'].map((id) => node(id)).concat(node('e', 'end')), edges: [
    { id: '1', from: 'a', to: 'b', on: 'done' }, { id: '2', from: 'b', to: 'c', on: 'done' }, { id: '3', from: 'c', to: 'e', on: 'done' }], loop: { maxRounds: 5, decision: 'x' } });
  const diamond = () => ({ nodes: [node('s'), node('l'), node('r'), node('t', 'end')], edges: [
    { id: '1', from: 's', to: 'l', on: 'done' }, { id: '2', from: 's', to: 'r', on: 'done' }, { id: '3', from: 'l', to: 't', on: 'done' }, { id: '4', from: 'r', to: 't', on: 'done' }], loop: { maxRounds: 5, decision: 'x' } });
  const pos = (wf, id) => wf.nodes.find((n) => n.id === id).position;

  it('lays a chain out left to right, 220 apart, starting at x 0', async () => {
    const { autoLayout } = await L();
    const wf = chain(); const before = frozen(wf);
    const out = autoLayout(wf);
    expect(frozen(wf)).toBe(before);
    expect(['a', 'b', 'c', 'e'].map((id) => pos(out, id).x)).toEqual([0, 220, 440, 660]);
    expect(out.edges).toEqual(wf.edges);
    expect(out.nodes.map((n) => n.id)).toEqual(wf.nodes.map((n) => n.id));
    expect(out.loop).toEqual(wf.loop);
  });

  it('puts parallel branches in one column on different rows', async () => {
    const { autoLayout } = await L();
    const out = autoLayout(diamond());
    expect(pos(out, 'l').x).toBe(220);
    expect(pos(out, 'r').x).toBe(220);
    expect(pos(out, 'l').y).not.toBe(pos(out, 'r').y);
    expect(pos(out, 't').x).toBe(440);
  });

  it('every node gets a distinct position, including the seed-like loops and unreachable nodes; back edges terminate', async () => {
    const { autoLayout } = await L();
    const wf = diamond();
    wf.edges.push({ id: '5', from: 't', to: 's', on: 'x' }); // a back edge
    wf.nodes.push(node('lonely'), node('lonely2'));
    const out = autoLayout(wf);
    const keys = out.nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(out.nodes.every((n) => Number.isFinite(n.position.x) && Number.isFinite(n.position.y))).toBe(true);
    expect(pos(out, 's').x).toBe(0);
  });

  it('is deterministic and idempotent on the real seed shape', async () => {
    const { autoLayout } = await L();
    const wf = chain();
    expect(autoLayout(wf)).toEqual(autoLayout(wf));
    expect(autoLayout(autoLayout(wf))).toEqual(autoLayout(wf));
  });

  it('handles an empty and a one-node graph', async () => {
    const { autoLayout } = await L();
    expect(autoLayout({ nodes: [], edges: [], loop: {} }).nodes).toEqual([]);
    expect(pos(autoLayout({ nodes: [node('only')], edges: [], loop: {} }), 'only')).toEqual({ x: 0, y: expect.any(Number) });
  });
});
