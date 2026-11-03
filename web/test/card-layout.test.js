import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { seedWorkflow } from '../../src/workflow.js';
import { FIT_VIEW } from '../src/editor/Canvas.jsx';
import { nodeStats, toFlow } from '../src/editor/toFlow.js';
import { autoLayout, CARD_W, LAYER_GAP } from '../src/lib/layout.js';
import { sample } from './fixtures.js';

const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');
const posOf = (wf) => Object.fromEntries(wf.nodes.map((n) => [n.id, n.position]));

describe('autoLayout side column', () => {
  const wf = autoLayout(seedWorkflow());
  const pos = posOf(wf);
  const side = ['decision', 'fix'];
  const main = wf.nodes.filter((n) => !side.includes(n.id));

  it('puts the loop decision and every fix-round target right of every main node, beyond its card edge', () => {
    const maxRight = Math.max(...main.map((n) => n.position.x + CARD_W));
    for (const id of side) expect(pos[id].x).toBeGreaterThan(maxRight);
    expect(new Set(side.map((id) => pos[id].x)).size).toBe(1);
  });

  it('puts the main path in layers going down, nodes of a layer side by side, never overlapping', () => {
    expect(['frame', 'gate1', 'plan', 'split', 'join', 'verify', 'review'].map((id) => pos[id].y)).toEqual([0, 160, 320, 480, 800, 960, 1120]);
    expect(pos.implement.y).toBe(pos.prep.y);
    expect(Math.abs(pos.implement.x - pos.prep.x)).toBeGreaterThan(CARD_W);
    const keys = wf.nodes.map((n) => `${n.position.x},${n.position.y}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('keeps two side nodes of one layer apart and ignores an unknown decision id', () => {
    const g = {
      nodes: ['a', 'b', 'c'].map((id) => ({ id, type: 'step' })),
      edges: [
        { id: '1', from: 'a', to: 'b', on: 'fail', fixRound: true },
        { id: '2', from: 'a', to: 'c', on: 'fail', fixRound: true },
      ],
      loop: { decision: 'nope' },
    };
    const p = posOf(autoLayout(g));
    expect(p.b.x).toBe(p.c.x);
    expect(Math.abs(p.b.y - p.c.y)).toBeGreaterThanOrEqual(LAYER_GAP);
    expect(p.a.x).toBeLessThan(p.b.x);
  });

  it('is idempotent and the seed positions are the auto-layout of the seed', () => {
    expect(autoLayout(wf)).toEqual(wf);
    expect(posOf(seedWorkflow())).toEqual(pos);
  });
});

describe('card contract', () => {
  it('names are 16 px, FIT_VIEW keeps them at 12 px or more at fit-to-view, and the card width matches the layout', () => {
    const size = Number(/\.fnode-name \{[^}]*font-size: (\d+)px/.exec(css)[1]);
    expect(size).toBe(16);
    expect(size * FIT_VIEW.minZoom).toBeGreaterThanOrEqual(12);
    expect(css).toMatch(new RegExp(`\\.fnode \\{[^}]*width: ${CARD_W}px`));
  });

  it('edge labels are the outcome only; fix-round edges get edge-fix, combined with edge-error', () => {
    const { edges } = toFlow(sample(), { errors: { nodes: new Set(), edges: new Set(['verify>plan:fail']) } });
    const fix = edges.find((e) => e.id === 'verify>plan:fail');
    expect(fix.label).toBe('fail');
    expect(fix.className).toBe('edge-fix edge-error');
    expect(edges.find((e) => e.id === 'plan>verify:done').className).toBeUndefined();
  });
});

describe('nodeStats', () => {
  const entry = { version: 3, finishedRuns: 4, nodes: [{ id: 'plan', runs: 3, avgTokens: 12_000, avgDurationMs: 250_000 }, { id: 'verify', runs: 0, avgTokens: 0, avgDurationMs: 0 }] };
  it('formats averages with the shared formatters, "never reached" at 0 runs, nothing for unlisted nodes', () => {
    const s = nodeStats(entry);
    expect(s.plan).toBe('≈ 12k tokens · 4m 10s avg');
    expect(s.verify).toBe('never reached');
    expect(s.pr).toBeUndefined();
    expect(toFlow(sample(), { stats: s }).nodes.find((n) => n.id === 'pr').data.stats).toBeUndefined();
  });
  it('says "no runs yet" for every listed node when the version has no finished runs; no entry -> no stats', () => {
    expect(nodeStats({ ...entry, finishedRuns: 0 })).toEqual({ plan: 'no runs yet', verify: 'no runs yet' });
    expect(nodeStats(undefined)).toBeUndefined();
  });
  it('split and join nodes get no stats line even with runs; steps keep theirs', () => {
    const wf = { nodes: [{ id: 'plan', type: 'step' }, { id: 'fan', type: 'split' }, { id: 'merge', type: 'join' }] };
    const e = { version: 3, finishedRuns: 4, nodes: [{ id: 'plan', runs: 4, avgTokens: 12_000, avgDurationMs: 250_000 }, { id: 'fan', runs: 4, avgTokens: 0, avgDurationMs: 0 }, { id: 'merge', runs: 4, avgTokens: 0, avgDurationMs: 0 }] };
    const s = nodeStats(e, wf);
    expect(s.plan).toBe('≈ 12k tokens · 4m 10s avg');
    expect(s).not.toHaveProperty('fan');
    expect(s).not.toHaveProperty('merge');
  });

  it('parallel edges between the same two nodes: the first carries every outcome, the rest no label, each stays its own edge', () => {
    const wf = {
      nodes: [{ id: 'a', type: 'step' }, { id: 'b', type: 'step' }, { id: 'c', type: 'step' }],
      edges: [
        { id: 'a>b:regression', from: 'a', to: 'b', on: 'regression' },
        { id: 'a>c:done', from: 'a', to: 'c', on: 'done' },
        { id: 'a>b:env', from: 'a', to: 'b', on: 'env' },
        { id: 'a>b:stuck', from: 'a', to: 'b', on: 'stuck' },
      ],
    };
    const { edges } = toFlow(wf);
    expect(edges.map((e) => e.id)).toEqual(['a>b:regression', 'a>c:done', 'a>b:env', 'a>b:stuck']);
    expect(edges.map((e) => e.label)).toEqual(['regression / env / stuck', 'done', undefined, undefined]);
  });

  it('theme: Controls, background, edges and attribution set the xyflow variables that win over its own defaults', () => {
    const rule = /\.canvas \{([^}]*)\}/.exec(css)[1];
    for (const v of ['edge-stroke', 'edge-label-color', 'edge-label-background-color', 'background-color', 'attribution-background-color', 'controls-button-background-color', 'controls-button-background-color-hover', 'controls-button-color', 'controls-button-color-hover', 'controls-button-border-color']) {
      expect(rule).toMatch(new RegExp(`--xy-${v}: `));
    }
    expect(rule).not.toMatch(/-default:/);
  });

  it('palette column is wide enough for one-line descriptions', () => {
    expect(css).toMatch(/\.editor-body \{[^}]*grid-template-columns: 220px/);
    expect(css).toMatch(/\.palette-desc \{[^}]*white-space: nowrap/);
  });
});
