// The Fleet stage stepper (web/src/lib/stepper.js) and the run-tab routes (contract C4).
import { describe, expect, it } from 'vitest';
import { seedWorkflow } from '../../src/workflow.js';
import { stageSteps } from '../src/lib/stepper.js';
import { parseRoute, runHref } from '../src/lib/route.js';

const visit = (node, outcome) => ({ node, outcome, enteredAt: '2026-11-22T10:00:00Z', leftAt: outcome ? '2026-11-22T10:01:00Z' : null });
const detail = (run, visits) => ({ run: { id: 'r', status: 'active', stage: 'implement', round: 0, ...run }, workflow: seedWorkflow(), visits, nodes: {} });

describe('stageSteps', () => {
  it('lists the pipeline stages in workflow order, without split, join, end and the loop-only fix and decision nodes', () => {
    const ids = stageSteps(detail({ active: [{ id: 'frame' }] }, [])).map((s) => s.id);
    expect(ids).toEqual(['frame', 'gate1', 'plan', 'implement', 'prep', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr']);
  });

  it('maps run states: passed -> done, running -> current, a gate on hold -> waiting, failed, never reached -> todo', () => {
    const d = detail({ active: [{ id: 'implement' }, { id: 'prep' }] }, [visit('frame', 'done'), visit('gate1', 'Agree spec'), visit('plan', 'done'), visit('implement', null), visit('prep', null)]);
    const by = Object.fromEntries(stageSteps(d).map((s) => [s.id, s.state]));
    expect(by).toMatchObject({ frame: 'done', gate1: 'done', plan: 'done', implement: 'current', prep: 'current', verify: 'todo', pr: 'todo' });
    const waiting = detail({ status: 'waiting', stage: 'gate1', active: [{ id: 'gate1' }] }, [visit('frame', 'done'), visit('gate1', null)]);
    expect(stageSteps(waiting).find((s) => s.id === 'gate1').state).toBe('waiting');
    const failed = detail({ stage: 'fix', active: [{ id: 'fix' }] }, [visit('verify', 'fail'), visit('fix', null)]);
    expect(stageSteps(failed).find((s) => s.id === 'verify').state).toBe('failed');
  });

  it('carries the stage names and gives nothing without a workflow or run', () => {
    expect(stageSteps(detail({ active: [{ id: 'frame' }] }, []))[0]).toEqual({ id: 'frame', name: 'Frame', state: 'current' });
    expect(stageSteps(null)).toEqual([]);
    expect(stageSteps({})).toEqual([]);
    expect(stageSteps({ run: { status: 'active' } })).toEqual([]);
  });
});

describe('run tab routes', () => {
  it('parses #/runs/<id>/<tab>; a missing or unknown tab is stages', () => {
    expect(parseRoute('#/runs/r1')).toEqual({ name: 'run', id: 'r1', tab: 'stages' });
    expect(parseRoute('#/runs/r1/crew')).toEqual({ name: 'run', id: 'r1', tab: 'crew' });
    expect(parseRoute('#/runs/r1/stages')).toEqual({ name: 'run', id: 'r1', tab: 'stages' });
    expect(parseRoute('#/runs/a%20b/ledger')).toEqual({ name: 'run', id: 'a b', tab: 'ledger' });
    expect(parseRoute('#/runs/r1/nope')).toEqual({ name: 'run', id: 'r1', tab: 'stages' });
    expect(parseRoute('#/runs/r1/')).toEqual({ name: 'run', id: 'r1', tab: 'stages' });
    expect(parseRoute('#/runs/r1/crew/x')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/runs/%E0%A4%A/crew')).toEqual({ name: 'monitor' });
  });

  it('builds tab links', () => {
    expect(runHref('a b')).toBe('#/runs/a%20b');
    expect(runHref('a b', 'crew')).toBe('#/runs/a%20b/crew');
  });
});
