import { describe, expect, it } from 'vitest';
import { formatTokens, splitRuns } from '../src/lib/format.js';
import { buildMap } from '../src/lib/map.js';
import { idleTime, relativeTime } from '../src/lib/time.js';

describe('time helpers', () => {
  const now = Date.parse('2026-10-23T12:00:00Z');
  it('relativeTime', () => {
    expect(relativeTime('2026-10-23T11:59:58Z', now)).toBe('just now');
    expect(relativeTime('2026-10-23T11:59:00Z', now)).toBe('1m ago');
    expect(relativeTime(new Date(now - 3 * 3600_000).toISOString(), now)).toBe('3h ago');
    expect(relativeTime(null, now)).toBe('-');
    expect(relativeTime('not a date', now)).toBe('-');
  });
  it('idleTime ticks per second', () => {
    expect(idleTime(new Date(now - 7000).toISOString(), now)).toBe('7s');
    expect(idleTime(new Date(now - 125_000).toISOString(), now)).toBe('2m 5s');
  });
});

describe('format', () => {
  it('formatTokens', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1234)).toBe('1.2k');
    expect(formatTokens(250_000)).toBe('250k');
    expect(formatTokens(2_500_000)).toBe('2.5M');
  });
  it('splitRuns', () => {
    const s = splitRuns([{ status: 'waiting' }, { status: 'active' }, { status: 'done' }, { status: 'stopped' }]);
    expect([s.waiting.length, s.live.length, s.finished.length]).toEqual([1, 2, 2]);
  });
});

describe('buildMap', () => {
  const wf = {
    loop: { fixRunner: 'worker' },
    stages: [
      { id: 'frame', name: 'Frame', kind: 'step', runner: 'main' },
      { id: 'gate1', name: 'Gate', kind: 'gate' },
      { id: 'impl', name: 'Implement', kind: 'step', runner: 'worker' },
      { id: 'verify', name: 'Verify', kind: 'step', runner: 'verifier', check: { onFail: 'fix' } },
    ],
  };
  const timeline = [
    { kind: 'stage', stage: 'frame' },
    { kind: 'stage', stage: 'gate1' },
    { kind: 'stage', stage: 'impl' },
    { kind: 'log', stage: 'verify' },
  ];
  it('orders columns, derives lanes, marks current and visited', () => {
    const m = buildMap(wf, { stage: 'impl', status: 'active', round: 1, maxRounds: 5 }, timeline);
    expect(m.columns.map((c) => c.id)).toEqual(['frame', 'gate1', 'impl', 'verify', 'done']);
    expect(m.lanes).toEqual(['main', 'you', 'worker', 'verifier']);
    expect(m.columns.filter((c) => c.current).map((c) => c.id)).toEqual(['impl']);
    expect(m.columns.filter((c) => c.visited).map((c) => c.id)).toEqual(['frame', 'gate1']);
    expect(m.side.map((s) => s.id)).toEqual(['fix', 'decision']);
  });
  it('highlights fix as a side node and done at the end', () => {
    expect(buildMap(wf, { stage: 'fix', status: 'active' }, []).side[0].current).toBe(true);
    expect(buildMap(wf, { stage: 'done', status: 'done' }, []).columns.at(-1).current).toBe(true);
  });
});
