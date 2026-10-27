import { describe, expect, it } from 'vitest';
import { formatDuration, formatTokens, splitRuns } from '../src/lib/format.js';
import { parseRoute, runHref } from '../src/lib/route.js';
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

describe('formatDuration', () => {
  it('formats spans and missing values', () => {
    expect(formatDuration(65_000)).toBe('1m 5s');
    expect(formatDuration(4000)).toBe('4s');
    expect(formatDuration(3 * 3600_000 + 120_000)).toBe('3h 2m');
    expect(formatDuration(null)).toBe('-');
  });
});

describe('parseRoute', () => {
  it('maps hashes to routes and falls back to the monitor', () => {
    expect(parseRoute('')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/workflow')).toEqual({ name: 'workflow' });
    expect(parseRoute('#/runs/my-run')).toEqual({ name: 'run', id: 'my-run' });
    expect(parseRoute('#/runs/a%20b')).toEqual({ name: 'run', id: 'a b' });
    expect(parseRoute('#/runs/%E0%A4%A')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/nope')).toEqual({ name: 'monitor' });
    expect(runHref('a b')).toBe('#/runs/a%20b');
  });
});
