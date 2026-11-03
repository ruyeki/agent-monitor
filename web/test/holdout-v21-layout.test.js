// Holdout AC2: top-to-bottom autoLayout with a side column. Vitest, pure.
import { describe, expect, it } from 'vitest';
import { autoLayout } from '../src/lib/layout.js';
import { seedWorkflow } from '../../src/workflow.js';

const P = (wf, id) => wf.nodes.find((n) => n.id === id).position;
const keys = (wf) => wf.nodes.map((n) => `${n.position.x},${n.position.y}`);
const step = (id) => ({ id, type: 'step', name: id, runner: 'worker', model: 'sonnet', position: { x: 0, y: 0 } });
const gate = (id) => ({ id, type: 'gate', name: id, ask: 'q', actions: [{ label: 'Resume' }], position: { x: 0, y: 0 } });
const e = (from, to, on, extra = {}) => ({ id: `${from}>${to}:${on}`, from, to, on, ...extra });
const CARD = 180;

const loopGraph = () => ({
  nodes: [step('a'), { ...step('b'), type: 'check' }, step('c'), step('fix'), gate('decision'), { id: 'end', type: 'end', name: 'End', position: { x: 0, y: 0 } }],
  edges: [e('a', 'b', 'done'), e('b', 'c', 'pass'), e('b', 'fix', 'fail', { fixRound: true }), e('b', 'decision', 'stuck'), e('fix', 'b', 'done'), e('c', 'end', 'done'), e('decision', 'a', 'Resume')],
  loop: { maxRounds: 5, decision: 'decision' },
});

describe('autoLayout top to bottom', () => {
  it('chain: one column, y strictly increasing from 0 with room for a card and a label', () => {
    const wf = autoLayout({ nodes: [step('a'), step('b'), step('c'), step('d')], edges: [e('a', 'b', 'done'), e('b', 'c', 'done'), e('c', 'd', 'done')] });
    const ys = ['a', 'b', 'c', 'd'].map((id) => P(wf, id).y);
    expect(ys[0]).toBe(0);
    for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(100);
    expect(new Set(['a', 'b', 'c', 'd'].map((id) => P(wf, id).x)).size).toBe(1);
  });
  it('parallel branches share a layer (same y), differ in x and are centred under the main column', () => {
    const wf = autoLayout({
      nodes: ['s', 'a', 'b', 'j'].map(step),
      edges: [e('s', 'a', '*'), e('s', 'b', '*'), e('a', 'j', 'done'), e('b', 'j', 'done')],
    });
    expect(P(wf, 'a').y).toBe(P(wf, 'b').y);
    expect(P(wf, 'a').x).not.toBe(P(wf, 'b').x);
    expect(P(wf, 'a').y).toBeGreaterThan(P(wf, 's').y);
    expect(P(wf, 'j').y).toBeGreaterThan(P(wf, 'a').y);
    expect((P(wf, 'a').x + P(wf, 'b').x) / 2).toBeCloseTo(P(wf, 's').x, 0);
    expect(new Set(keys(wf)).size).toBe(4);
  });
  it('ignores back edges when layering (a loop does not push nodes up or sideways)', () => {
    const wf = autoLayout({ nodes: [step('a'), step('b'), step('c')], edges: [e('a', 'b', 'done'), e('b', 'c', 'done'), e('c', 'a', 'fail')] });
    expect(P(wf, 'a').y).toBeLessThan(P(wf, 'b').y);
    expect(P(wf, 'b').y).toBeLessThan(P(wf, 'c').y);
  });
  it('puts loop.decision and every fixRound target in a side column right of every main node', () => {
    const wf = autoLayout(loopGraph());
    const main = ['a', 'b', 'c', 'end'].map((id) => P(wf, id));
    const maxMain = Math.max(...main.map((p) => p.x));
    for (const id of ['fix', 'decision']) expect(P(wf, id).x).toBeGreaterThanOrEqual(maxMain + CARD);
    expect(new Set(keys(wf)).size).toBe(wf.nodes.length);
    // main path still goes down
    expect(P(wf, 'a').y).toBeLessThan(P(wf, 'b').y);
    expect(P(wf, 'b').y).toBeLessThan(P(wf, 'c').y);
    expect(P(wf, 'c').y).toBeLessThan(P(wf, 'end').y);
  });
  it('two fixRound targets in the same layer still get distinct side positions', () => {
    const wf = autoLayout({
      nodes: [step('a'), { ...step('b'), type: 'check' }, step('f1'), step('f2'), { id: 'z', type: 'end', name: 'Z', position: { x: 0, y: 0 } }],
      edges: [e('a', 'b', 'done'), e('b', 'z', 'pass'), e('b', 'f1', 'fail', { fixRound: true }), e('b', 'f2', 'finding', { fixRound: true }), e('f1', 'b', 'done'), e('f2', 'b', 'done')],
      loop: { maxRounds: 5, decision: 'nope' },
    });
    expect(new Set(keys(wf)).size).toBe(wf.nodes.length);
    const maxMain = Math.max(...['a', 'b', 'z'].map((id) => P(wf, id).x));
    expect(P(wf, 'f1').x).toBeGreaterThanOrEqual(maxMain + CARD);
    expect(P(wf, 'f2').x).toBeGreaterThanOrEqual(maxMain + CARD);
  });
  it('a missing loop or a decision id that is not a node does not throw', () => {
    const g = loopGraph();
    delete g.loop;
    expect(() => autoLayout(g)).not.toThrow();
    g.loop = { maxRounds: 5, decision: 'ghost' };
    expect(autoLayout(g).nodes).toHaveLength(g.nodes.length);
  });
  it('is deterministic, idempotent and does not mutate its input', () => {
    const wf = loopGraph();
    const before = JSON.stringify(wf);
    const once = autoLayout(wf);
    expect(JSON.stringify(wf)).toBe(before);
    expect(autoLayout(wf)).toEqual(once);
    expect(autoLayout(once)).toEqual(once);
    expect(autoLayout({ nodes: [], edges: [] }).nodes).toEqual([]);
  });
  it('lays the real seed out vertically with side nodes outside the main column', () => {
    const wf = autoLayout(seedWorkflow());
    const order = ['frame', 'gate1', 'plan', 'split', 'implement', 'join', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr', 'done'];
    // implement and prep share a layer
    expect(P(wf, 'implement').y).toBe(P(wf, 'prep').y);
    expect(P(wf, 'implement').x).not.toBe(P(wf, 'prep').x);
    for (let i = 1; i < order.length; i++) expect(P(wf, order[i]).y).toBeGreaterThan(P(wf, order[i - 1]).y);
    const mainIds = wf.nodes.map((n) => n.id).filter((id) => !['fix', 'decision'].includes(id) && id !== 'stopped');
    const maxMain = Math.max(...mainIds.map((id) => P(wf, id).x));
    expect(P(wf, 'fix').x).toBeGreaterThanOrEqual(maxMain + CARD);
    expect(P(wf, 'decision').x).toBeGreaterThanOrEqual(maxMain + CARD);
    expect(new Set(keys(wf)).size).toBe(wf.nodes.length);
  });
  it('seedWorkflow() stored positions equal autoLayout(seedWorkflow()) (kept in sync)', () => {
    const seed = seedWorkflow();
    const laid = autoLayout(seed);
    for (const n of seed.nodes) expect(n.position).toEqual(P(laid, n.id));
  });
});
