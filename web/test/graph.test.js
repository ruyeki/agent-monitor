import { describe, expect, it } from 'vitest';
import { STAGE_GAP, buildGraph } from '../src/lib/graph.js';
import { moveStage, reorderByDrop } from '../src/lib/reorder.js';
import { sample } from './fixtures.js';

const has = (g, source, target, label) => g.edges.some((e) => e.source === source && e.target === target && e.label === label);
const ids = (stages) => stages.map((s) => s.id);

describe('buildGraph', () => {
  const g = buildGraph(sample());
  it('places spine stages by order and adds the synthetic nodes', () => {
    expect(g.nodes.find((n) => n.id === 'review').position).toEqual({ x: 2 * STAGE_GAP, y: 0 });
    expect(g.nodes.find((n) => n.id === 'done').position.x).toBe(6 * STAGE_GAP);
    for (const id of ['fix', 'decision', 'done', 'stopped']) expect(g.nodes.some((n) => n.id === id)).toBe(true);
    expect(g.nodes.find((n) => n.id === 'fix').position.y).toBeGreaterThan(0);
  });
  it('draws pass edges along the spine, last to done', () => {
    expect(has(g, 'plan', 'verify', 'pass')).toBe(true);
    expect(has(g, 'pr', 'done', 'pass')).toBe(true);
  });
  it('maps check failures to fix or decision and none for continue', () => {
    expect(has(g, 'verify', 'fix', 'fail')).toBe(true);
    expect(has(g, 'review', 'decision', 'fail')).toBe(true);
    expect(g.edges.filter((e) => e.source === 'whitehat' && e.label === 'fail')).toEqual([]);
  });
  it('wires fix, decision and stopped', () => {
    expect(has(g, 'fix', 'verify', 'done')).toBe(true);
    expect(has(g, 'decision', 'plan', 'Resume')).toBe(true);
    expect(has(g, 'decision', 'stopped', 'Stop run')).toBe(true);
  });
  it('maps gate actions: next, stage, stop; drops missing targets', () => {
    expect(has(g, 'gate2', 'pr', 'Accept')).toBe(true);
    expect(has(g, 'gate2', 'plan', 'Redo')).toBe(true);
    expect(has(g, 'gate2', 'stopped', 'Stop run')).toBe(true);
    expect(g.edges.some((e) => e.label === 'Lost')).toBe(false);
  });
  it('drops loop edges whose stage is missing and gives unique edge ids', () => {
    const wf = sample();
    wf.loop.afterFix = 'nope';
    const g2 = buildGraph(wf);
    expect(g2.edges.some((e) => e.source === 'fix')).toBe(false);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });
});

describe('reorderByDrop and moveStage', () => {
  const stages = sample().stages;
  it('drops White-hat before Review', () => {
    expect(ids(reorderByDrop(stages, 'whitehat', 2 * STAGE_GAP - 30))).toEqual(['plan', 'verify', 'whitehat', 'review', 'gate2', 'pr']);
  });
  it('clamps to the ends', () => {
    expect(ids(reorderByDrop(stages, 'verify', -999))[0]).toBe('verify');
    expect(ids(reorderByDrop(stages, 'plan', 99999)).at(-1)).toBe('plan');
  });
  it('keeps the order for an unknown id and does not mutate', () => {
    const before = ids(stages);
    expect(ids(reorderByDrop(stages, 'zzz', 300))).toEqual(before);
    expect(ids(stages)).toEqual(before);
  });
  it('moveStage moves to an index', () => {
    expect(ids(moveStage(stages, 'pr', 0))[0]).toBe('pr');
    expect(ids(moveStage(stages, 'plan', 1)).slice(0, 2)).toEqual(['verify', 'plan']);
  });
});

it('a stage id that is an Object.prototype key is not treated as a synthetic node', () => {
  const wf = sample();
  const gate = wf.stages.find((s) => s.kind === 'gate');
  for (const goto of ['constructor', 'toString']) {
    gate.actions[0].goto = goto;
    expect(buildGraph(wf).edges.some((e) => e.target === goto)).toBe(false);
  }
});
