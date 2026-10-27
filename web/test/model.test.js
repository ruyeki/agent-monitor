import { describe, expect, it } from 'vitest';
import {
  addAction, addNode, connect, idProblem, onChoices, patchEdge, patchNode, removeAction, removeEdge, removeNode, renameAction, renameNode, setNodeType,
} from '../src/editor/model.js';
import { sample } from './fixtures.js';

describe('addNode', () => {
  it('adds a node of the type at the position with a unique id and does not mutate', () => {
    const wf = sample();
    const before = JSON.stringify(wf);
    const a = addNode(wf, 'step', { x: 10.4, y: 20.6 });
    const b = addNode(a, 'step', { x: 0, y: 0 });
    expect(JSON.stringify(wf)).toBe(before);
    expect(a.nodes.at(-1)).toMatchObject({ id: 'step-2', type: 'step', position: { x: 10, y: 21 }, runner: 'worker', model: 'inherit' });
    expect(b.nodes.at(-1).id).toBe('step-3');
  });
  it('gives gates an ask, two actions and a text field; checks the verifier runner', () => {
    const g = addNode(sample(), 'gate', { x: 0, y: 0 }).nodes.at(-1);
    expect(g.ask).toBeTruthy();
    expect(g.actions.length).toBe(2);
    expect(g.textField).toBe(true);
    expect(addNode(sample(), 'check', { x: 0, y: 0 }).nodes.at(-1).runner).toBe('verifier');
    expect(addNode(sample(), 'split', { x: 0, y: 0 }).nodes.at(-1).actions).toBeUndefined();
  });
});

describe('removeNode / removeEdge', () => {
  it('removeNode drops the node and its edges', () => {
    const wf = removeNode(sample(), 'verify');
    expect(wf.nodes.map((n) => n.id)).not.toContain('verify');
    expect(wf.edges.some((e) => e.from === 'verify' || e.to === 'verify')).toBe(false);
    expect(wf.edges.length).toBe(3);
  });
  it('removeEdge drops one edge', () => {
    expect(removeEdge(sample(), 'plan>verify:done').edges.length).toBe(5);
  });
});

describe('connect', () => {
  const base = () => ({
    nodes: [
      { id: 'a', type: 'step' }, { id: 'c', type: 'check' }, { id: 'g', type: 'gate', actions: [{ label: 'Yes' }, { label: 'No' }] },
      { id: 's', type: 'split' }, { id: 'j', type: 'join' }, { id: 'e', type: 'end' }, { id: 'x', type: 'step' },
    ],
    edges: [],
    loop: {},
  });
  it('picks the default on per source type', () => {
    expect(connect(base(), 'a', 'x').edges[0]).toEqual({ id: 'a>x:done', from: 'a', to: 'x', on: 'done' });
    expect(connect(connect(base(), 'c', 'a'), 'c', 'x').edges.map((e) => e.on)).toEqual(['pass', 'fail']);
    expect(connect(connect(base(), 'g', 'a'), 'g', 'x').edges.map((e) => e.on)).toEqual(['Yes', 'No']);
    expect(connect(base(), 's', 'a').edges[0].on).toBe('*');
    expect(connect(base(), 'j', 'a').edges[0].on).toBe('*');
  });
  it('honours an explicit on and ignores end sources, unknown nodes and exact duplicates', () => {
    expect(connect(base(), 'a', 'x', 'stuck').edges[0].on).toBe('stuck');
    const wf = base();
    expect(connect(wf, 'e', 'a')).toBe(wf);
    expect(connect(wf, 'a', 'nope')).toBe(wf);
    const once = connect(wf, 'a', 'x');
    expect(connect(once, 'a', 'x')).toBe(once);
  });
});

describe('patch and rename', () => {
  it('patchNode and patchEdge merge fields', () => {
    expect(patchNode(sample(), 'plan', { name: 'Planning' }).nodes[0].name).toBe('Planning');
    const e = patchEdge(sample(), 'verify>plan:fail', { fixRound: false }).edges.find((x) => x.id === 'verify>plan:fail');
    expect(e.fixRound).toBe(false);
  });
  it('renameNode rewrites edges and loop.decision', () => {
    const wf = renameNode(sample(), 'gate2', 'accept');
    expect(wf.nodes.map((n) => n.id)).toContain('accept');
    expect(wf.edges.filter((e) => e.from === 'accept').length).toBe(2);
    expect(wf.edges.some((e) => e.to === 'accept')).toBe(true);
    expect(wf.edges.some((e) => e.from === 'gate2' || e.to === 'gate2')).toBe(false);
    expect(wf.loop.decision).toBe('accept');
  });
  it('idProblem', () => {
    const wf = sample();
    expect(idProblem(wf, 'plan', 'plan')).toBeNull();
    expect(idProblem(wf, 'plan', 'fresh_id-1')).toBeNull();
    expect(idProblem(wf, 'plan', '')).toMatch(/empty/);
    expect(idProblem(wf, 'plan', 'Bad Id')).toMatch(/lowercase/);
    expect(idProblem(wf, 'plan', 'verify')).toMatch(/already/);
  });
  it('setNodeType adds gate fields and drops them again', () => {
    const g = setNodeType(sample(), 'plan', 'gate').nodes[0];
    expect(g.type).toBe('gate');
    expect(g.actions.length).toBe(2);
    const s = setNodeType(setNodeType(sample(), 'plan', 'gate'), 'plan', 'step').nodes[0];
    expect(s.ask).toBeUndefined();
    expect(s.actions).toBeUndefined();
  });
});

describe('gate actions keep edges in sync', () => {
  it('renameAction renames the matching edge on', () => {
    const wf = renameAction(sample(), 'gate2', 0, 'Approve');
    expect(wf.nodes.find((n) => n.id === 'gate2').actions[0].label).toBe('Approve');
    expect(wf.edges.find((e) => e.id === 'gate2>pr:Accept').on).toBe('Approve');
  });
  it('removeAction removes the action and its edge', () => {
    const wf = removeAction(sample(), 'gate2', 1);
    expect(wf.nodes.find((n) => n.id === 'gate2').actions.map((a) => a.label)).toEqual(['Accept']);
    expect(wf.edges.some((e) => e.from === 'gate2' && e.on === 'Stop run')).toBe(false);
  });
  it('addAction adds a unique label', () => {
    const wf = addAction(addAction(sample(), 'gate2'), 'gate2');
    const labels = wf.nodes.find((n) => n.id === 'gate2').actions.map((a) => a.label);
    expect(new Set(labels).size).toBe(4);
  });
});

describe('onChoices', () => {
  it('lists the valid on values for a source', () => {
    const by = (id) => sample().nodes.find((n) => n.id === id);
    expect(onChoices(by('plan'))).toEqual(['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck', '*']);
    expect(onChoices(by('gate2'))).toEqual(['Accept', 'Stop run']);
    expect(onChoices(by('done'))).toEqual([]);
    expect(onChoices({ type: 'split' })).toEqual(['*']);
  });
});
