import { describe, expect, it } from 'vitest';
import { monitorHref, nextTag, pageKey, parseRoute } from '../src/lib/route.js';

describe('parseRoute with views', () => {
  it('reads the view from #/?view=', () => {
    for (const v of ['waiting', 'active', 'finished']) expect(parseRoute(`#/?view=${v}`)).toEqual({ name: 'monitor', view: v });
  });
  it('ignores an unknown or empty view, and keeps #/waiting on the plain Monitor', () => {
    expect(parseRoute('#/?view=nope')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/?view=')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/?other=1')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/waiting')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/')).toEqual({ name: 'monitor' });
    expect(parseRoute('')).toEqual({ name: 'monitor' });
  });
  it('monitorHref is the inverse', () => {
    expect(monitorHref('active')).toBe('#/?view=active');
    expect(monitorHref(null)).toBe('#/');
    expect(parseRoute(monitorHref('finished')).view).toBe('finished');
  });
});

describe('pageKey', () => {
  it('drops the run tab and keeps the view', () => {
    expect(pageKey(parseRoute('#/runs/r1/crew'))).toBe('run:r1');
    expect(pageKey(parseRoute('#/runs/r1'))).toBe('run:r1');
    expect(pageKey(parseRoute('#/runs/r2'))).toBe('run:r2');
    expect(pageKey(parseRoute('#/?view=active'))).toBe('monitor:active');
    expect(pageKey(parseRoute('#/'))).toBe('monitor:');
    expect(pageKey(parseRoute('#/stats'))).toBe('stats');
  });
});

describe('nextTag', () => {
  it('first load has no in-app history', () => {
    expect(nextTag(null, 'run:a')).toEqual({ key: 'run:a', backSteps: 0 });
  });
  it('a different page is one step back; tab switches add steps', () => {
    const stats = nextTag(null, 'stats');
    const run = nextTag(stats, 'run:a');
    expect(run).toEqual({ key: 'run:a', backSteps: 1 });
    const crew = nextTag(run, 'run:a');
    const ledger = nextTag(crew, 'run:a');
    expect(ledger).toEqual({ key: 'run:a', backSteps: 3 });
    expect(nextTag(ledger, 'run:b')).toEqual({ key: 'run:b', backSteps: 1 });
  });
  it('a run opened directly keeps backSteps 0 through its tab switches', () => {
    const direct = nextTag(null, 'run:a');
    const crew = nextTag(direct, 'run:a');
    const ledger = nextTag(crew, 'run:a');
    expect(crew).toEqual({ key: 'run:a', backSteps: 0 });
    expect(ledger).toEqual({ key: 'run:a', backSteps: 0 });
  });
});
