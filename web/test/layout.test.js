import { describe, expect, it } from 'vitest';
import { autoLayout } from '../src/lib/layout.js';
import { sample } from './fixtures.js';

const pos = (wf, id) => wf.nodes.find((n) => n.id === id).position;
const distinct = (wf) => new Set(wf.nodes.map((n) => `${n.position.x},${n.position.y}`)).size;

describe('autoLayout', () => {
  it('lays the spine out left to right, ignoring the back edge', () => {
    const wf = autoLayout(sample());
    expect(['plan', 'verify', 'gate2', 'pr', 'done'].map((id) => pos(wf, id).x)).toEqual([0, 220, 440, 660, 880]);
  });
  it('stacks parallel branches in one layer with distinct positions', () => {
    const wf = autoLayout({
      nodes: ['s', 'a', 'b', 'j'].map((id) => ({ id, type: 'step', position: { x: 0, y: 0 } })),
      edges: [
        { id: '1', from: 's', to: 'a', on: '*' },
        { id: '2', from: 's', to: 'b', on: '*' },
        { id: '3', from: 'a', to: 'j', on: 'done' },
        { id: '4', from: 'b', to: 'j', on: 'done' },
      ],
    });
    expect([pos(wf, 'a').x, pos(wf, 'b').x, pos(wf, 'j').x]).toEqual([220, 220, 440]);
    expect(distinct(wf)).toBe(4);
  });
  it('uses the longest path for depth and keeps unreachable nodes distinct', () => {
    const wf = autoLayout({
      nodes: ['a', 'b', 'c', 'lost'].map((id) => ({ id, type: 'step' })),
      edges: [
        { id: '1', from: 'a', to: 'b', on: 'done' },
        { id: '2', from: 'b', to: 'c', on: 'done' },
        { id: '3', from: 'a', to: 'c', on: 'fail' },
      ],
    });
    expect(pos(wf, 'c').x).toBe(440);
    expect(distinct(wf)).toBe(4);
  });
  it('does not mutate the input and handles an empty graph', () => {
    const wf = sample();
    const before = JSON.stringify(wf);
    autoLayout(wf);
    expect(JSON.stringify(wf)).toBe(before);
    expect(autoLayout({ nodes: [], edges: [] }).nodes).toEqual([]);
  });
});
