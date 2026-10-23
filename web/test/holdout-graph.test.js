import { describe, expect, it } from 'vitest';
import { buildGraph, STAGE_GAP } from '../src/lib/graph.js';

const step = (id, check = null) => ({ id, name: id.toUpperCase(), kind: 'step', runner: 'worker', model: 'inherit', instructions: '', check, pushes: false });
const gate = (id, actions) => ({ id, name: id, kind: 'gate', ask: 'ok?', actions, textField: true });
const wf = (stages, loop = {}) => ({ stages, loop: { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'a', resumeAt: 'a', ...loop } });
const has = (g, source, target, label) => g.edges.some((e) => e.source === source && e.target === target && e.label === label);
const edgesFrom = (g, s) => g.edges.filter((e) => e.source === s);
const node = (g, id) => g.nodes.find((n) => n.id === id);

describe('buildGraph', () => {
  it('exports a 220 gap', () => expect(STAGE_GAP).toBe(220));

  it('lays nodes out from the order and adds the synthetic nodes', () => {
    const g = buildGraph(wf([step('a'), step('b'), step('c')]));
    const ids = g.nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['a', 'b', 'c', 'decision', 'done', 'fix', 'stopped']);
    ['a', 'b', 'c'].forEach((id, i) => expect(node(g, id).position).toEqual({ x: i * STAGE_GAP, y: 0 }));
    expect(node(g, 'done').position.x).toBeGreaterThan(node(g, 'c').position.x);
    for (const id of ['fix', 'decision', 'stopped']) expect(node(g, id).position.y).toBeGreaterThan(0);
    expect(new Set(g.edges.map((e) => e.id)).size).toBe(g.edges.length);
  });

  it('moving a stage in the order moves its node', () => {
    const g = buildGraph(wf([step('b'), step('a')]));
    expect(node(g, 'b').position.x).toBe(0);
    expect(node(g, 'a').position.x).toBe(STAGE_GAP);
  });

  it('pass chain, last stage goes to done', () => {
    const g = buildGraph(wf([step('a'), step('b'), step('c')]));
    expect(has(g, 'a', 'b', 'pass')).toBe(true);
    expect(has(g, 'b', 'c', 'pass')).toBe(true);
    expect(has(g, 'c', 'done', 'pass')).toBe(true);
    expect(edgesFrom(g, 'a').filter((e) => e.label === 'pass')).toHaveLength(1);
  });

  it('check onFail fix / decision / continue', () => {
    const g = buildGraph(wf([step('a', { onFail: 'fix' }), step('b', { onFail: 'decision' }), step('c', { onFail: 'continue' })]));
    expect(has(g, 'a', 'fix', 'fail')).toBe(true);
    expect(has(g, 'b', 'decision', 'fail')).toBe(true);
    expect(edgesFrom(g, 'c').map((e) => e.label)).toEqual(['pass']);
    expect(has(g, 'a', 'decision', 'fail')).toBe(false);
  });

  it('fix -> afterFix, decision -> resumeAt and stopped', () => {
    const g = buildGraph(wf([step('a'), step('b', { onFail: 'fix' })], { afterFix: 'b', resumeAt: 'a' }));
    expect(has(g, 'fix', 'b', 'done')).toBe(true);
    expect(has(g, 'decision', 'a', 'Resume')).toBe(true);
    expect(has(g, 'decision', 'stopped', 'Stop run')).toBe(true);
  });

  it('gate actions: next, stop, stage', () => {
    const g = buildGraph(wf([step('a'), gate('g', [{ label: 'Go', goto: 'next' }, { label: 'Halt', goto: 'stop' }, { label: 'Back', goto: 'a' }]), step('c')]));
    expect(has(g, 'g', 'c', 'Go')).toBe(true);
    expect(has(g, 'g', 'stopped', 'Halt')).toBe(true);
    expect(has(g, 'g', 'a', 'Back')).toBe(true);
  });

  it('gate next on the last stage goes to done', () => {
    const g = buildGraph(wf([step('a'), gate('g', [{ label: 'Go', goto: 'next' }])]));
    expect(has(g, 'g', 'done', 'Go')).toBe(true);
  });

  it('drops edges to missing stages and does not throw on an invalid draft', () => {
    const g = buildGraph(wf([step('a', { onFail: 'fix' }), gate('g', [{ label: 'Nope', goto: 'ghost' }])], { afterFix: 'ghost', resumeAt: 'ghost2' }));
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
    expect(g.edges.some((e) => e.label === 'Nope')).toBe(false);
    expect(edgesFrom(g, 'fix').some((e) => e.label === 'done')).toBe(false);
    expect(edgesFrom(g, 'decision').some((e) => e.label === 'Resume')).toBe(false);
    expect(has(g, 'decision', 'stopped', 'Stop run')).toBe(true);
  });

  it('empty stage list does not throw', () => {
    expect(() => buildGraph(wf([]))).not.toThrow();
  });
});
