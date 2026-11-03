import { describe, expect, it } from 'vitest';
import { runState } from '../src/run/runState.js';
import { sample } from './fixtures.js';

const detail = ({ active = [], status = 'active', visits = [], nodes = {} } = {}) => ({
  run: { status, stage: active[0], active: active.map((id) => ({ id })) },
  workflow: sample(),
  visits,
  nodes,
});
const v = (node, outcome = 'done') => ({ node, outcome });
const of = (d, id) => runState(d)[id];

describe('runState', () => {
  it('marks nodes the run is on: running, waiting at a gate, decision needed at the loop decision', () => {
    expect(of(detail({ active: ['plan'] }), 'plan')).toMatchObject({ state: 'running', status: '▶ running' });
    const g = detail({ active: ['gate2'] });
    g.workflow.loop.decision = 'x';
    expect(of(g, 'gate2')).toMatchObject({ state: 'waiting', status: '⏸ waiting on Ryan' });
    expect(of(detail({ active: ['gate2'] }), 'gate2')).toMatchObject({ state: 'decision', status: '✕ decision needed' }); // sample loop.decision = gate2
  });

  it('colours by the latest visit: pass/done green, failure outcomes red, stopped/cancelled grey', () => {
    expect(of(detail({ visits: [v('plan', 'done')] }), 'plan')).toMatchObject({ state: 'passed', status: '✓ done' });
    expect(of(detail({ visits: [v('verify', 'pass')] }), 'verify')).toMatchObject({ state: 'passed', status: '✓ pass' });
    for (const o of ['fail', 'finding', 'regression', 'env', 'stuck']) {
      expect(of(detail({ visits: [v('verify', o)] }), 'verify')).toMatchObject({ state: 'failed', status: `✕ ${o}` });
    }
    expect(of(detail({ visits: [v('verify', 'stopped')] }), 'verify')).toMatchObject({ state: 'halted', status: '– stopped' });
    expect(of(detail({ visits: [v('verify', 'cancelled')] }), 'verify')).toMatchObject({ state: 'halted', status: '– cancelled' });
  });

  it('an answered gate is passed with its label; an unvisited node is idle with no status', () => {
    expect(of(detail({ visits: [v('gate2', 'Accept')] }), 'gate2')).toMatchObject({ state: 'passed', status: '✓ Accept' });
    expect(of(detail(), 'pr')).toMatchObject({ state: 'idle', status: null, fails: 0 });
  });

  it('the latest visit decides, and earlier failures are counted', () => {
    const d = detail({ visits: [v('verify', 'fail'), v('verify', 'finding'), v('verify', 'pass')] });
    expect(of(d, 'verify')).toMatchObject({ state: 'passed', fails: 2 });
    const e = detail({ active: ['verify'], visits: [v('verify', 'fail'), { node: 'verify', outcome: null }] });
    expect(of(e, 'verify')).toMatchObject({ state: 'running', fails: 1 });
    expect(of(detail({ visits: [v('verify', 'pass'), v('verify', 'fail')] }), 'verify')).toMatchObject({ state: 'failed', fails: 0 });
  });

  it('an end node is passed when the run is done, halted otherwise', () => {
    expect(of(detail({ status: 'done', visits: [v('done', null)] }), 'done')).toMatchObject({ state: 'passed', status: '✓ done' });
    expect(of(detail({ status: 'stopped', visits: [v('done', null)] }), 'done')).toMatchObject({ state: 'halted', status: '– stopped' });
  });

  it('split/join have no visits: passed once a direct target has one, idle before', () => {
    const withSplit = (d) => {
      d.workflow.nodes.push({ id: 'sp', type: 'split' });
      d.workflow.edges.push({ id: 'sp>plan', from: 'sp', to: 'plan', on: '*' });
      return d;
    };
    expect(of(withSplit(detail({ visits: [v('plan')] })), 'sp')).toMatchObject({ state: 'passed' });
    expect(of(withSplit(detail()), 'sp')).toMatchObject({ state: 'idle', status: null });
  });

  it('carries visits and tokens from the node stats', () => {
    const d = detail({ nodes: { plan: { visits: 2, tokens: { total: 5000 } }, verify: { visits: 1 } } });
    expect(of(d, 'plan')).toMatchObject({ visits: 2, tokens: 5000 });
    expect(of(d, 'verify')).toMatchObject({ visits: 1, tokens: null });
    expect(of(d, 'pr')).toMatchObject({ visits: 0, tokens: null });
  });
});
