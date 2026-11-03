// Baseline kept from the v2.1 verifier: behaviour the v2.1 change must not break. Layout-direction-neutral.
import { describe, expect, it } from 'vitest';
import { autoLayout } from '../src/lib/layout.js';
import { toFlow, errorTargets } from '../src/editor/toFlow.js';
import { formatDuration, formatTokens } from '../src/lib/format.js';
import { addNode, connect } from '../src/editor/model.js';
import { seedWorkflow } from '../../src/workflow.js';

describe('baseline: autoLayout invariants that survive a direction change', () => {
  it('seed: positions distinct, same ids/order, input untouched, pure and idempotent, empty graph', () => {
    const seed = seedWorkflow();
    const before = JSON.stringify(seed);
    const a = autoLayout(seed);
    expect(JSON.stringify(seed)).toBe(before);
    expect(a.nodes.map((n) => n.id)).toEqual(seed.nodes.map((n) => n.id));
    expect(new Set(a.nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(seed.nodes.length);
    expect(autoLayout(seed)).toEqual(a);
    expect(autoLayout(a)).toEqual(a);
    expect(autoLayout({ nodes: [], edges: [] }).nodes).toEqual([]);
    expect(a.edges).toEqual(seed.edges);
    expect(a.loop).toEqual(seed.loop);
  });
  it('unreachable nodes still get distinct positions', () => {
    const wf = autoLayout({ nodes: ['a', 'b', 'lost'].map((id) => ({ id, type: 'step' })), edges: [{ id: '1', from: 'a', to: 'b', on: 'done' }] });
    expect(new Set(wf.nodes.map((n) => `${n.position.x},${n.position.y}`)).size).toBe(3);
  });
});

describe('baseline: toFlow and helpers', () => {
  it('maps every node and edge with stable ids, endpoints and the on label for ordinary edges', () => {
    const wf = seedWorkflow();
    const { nodes, edges } = toFlow(wf, { selected: { kind: 'node', id: 'plan' }, errors: errorTargets([{ message: 'x', node: 'verify', edge: 'verify>review:pass' }]) });
    expect(nodes.map((n) => n.id)).toEqual(wf.nodes.map((n) => n.id));
    expect(nodes.every((n) => n.type === 'wf')).toBe(true);
    expect(nodes.find((n) => n.id === 'plan').selected).toBe(true);
    expect(nodes.find((n) => n.id === 'verify').data.error).toBe(true);
    expect(nodes.find((n) => n.id === 'verify').data.node).toBe(wf.nodes.find((n) => n.id === 'verify'));
    expect(edges.map((e) => e.id)).toEqual(wf.edges.map((e) => e.id));
    const e = edges.find((x) => x.id === 'verify>review:pass');
    expect([e.source, e.target, e.label]).toEqual(['verify', 'review', 'pass']);
    expect(e.className).toContain('edge-error');
    expect(edges.find((x) => x.id === 'gate1>plan:Agree spec').label).toBe('Agree spec');
  });
  it('run info reaches data.run: visits and token totals', () => {
    const wf = seedWorkflow();
    const { nodes } = toFlow(wf, { runInfo: { active: new Set(), nodes: { plan: { visits: 2, tokens: { total: 5 } } }, plan: { state: 'passed', visits: 2, tokens: 5 }, pr: { state: 'idle', visits: 0 } } }); // carries both the old ({active,nodes}) and the new (per-id map) runInfo shape
    expect(nodes.find((n) => n.id === 'plan').data.run).toMatchObject({ visits: 2, tokens: 5 });
    expect(nodes.find((n) => n.id === 'pr').data.run.visits).toBe(0);
  });
  it('formatters give the strings the Stats page uses', () => {
    expect([formatTokens(0), formatTokens(999), formatTokens(1500), formatTokens(12345), formatTokens(2_500_000)]).toEqual(['0', '999', '1.5k', '12k', '2.5M']);
    expect([formatDuration(null), formatDuration(5000), formatDuration(65_000), formatDuration(3_725_000)]).toEqual(['-', '5s', '1m 5s', '1h 2m']);
  });
  it('model helpers still add and connect nodes', () => {
    const wf = addNode(seedWorkflow(), 'step', { x: 10, y: 20 });
    expect(wf.nodes.at(-1)).toMatchObject({ type: 'step', position: { x: 10, y: 20 } });
    expect(connect(wf, wf.nodes.at(-1).id, 'done').edges.length).toBe(wf.edges.length + 1);
  });
});
