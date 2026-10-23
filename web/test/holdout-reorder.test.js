import { describe, expect, it } from 'vitest';
import { STAGE_GAP } from '../src/lib/graph.js';
import { moveStage, reorderByDrop } from '../src/lib/reorder.js';

const mk = (...ids) => ids.map((id) => ({ id }));
const ids = (a) => a.map((s) => s.id);
const S = mk('frame', 'plan', 'verify', 'review', 'whitehat', 'commit');

describe('reorderByDrop', () => {
  it('drop at Review x puts White-hat before Review', () => {
    expect(ids(reorderByDrop(S, 'whitehat', 3 * STAGE_GAP))).toEqual(['frame', 'plan', 'verify', 'whitehat', 'review', 'commit']);
  });
  it('rounds to the nearest slot', () => {
    expect(ids(reorderByDrop(S, 'whitehat', 3 * STAGE_GAP + 90))).toEqual(ids(reorderByDrop(S, 'whitehat', 3 * STAGE_GAP)));
    expect(ids(reorderByDrop(S, 'whitehat', 3 * STAGE_GAP + 130))).toEqual(ids(reorderByDrop(S, 'whitehat', 4 * STAGE_GAP)));
  });
  it('clamps at both ends', () => {
    expect(ids(reorderByDrop(S, 'review', -5000))[0]).toBe('review');
    expect(ids(reorderByDrop(S, 'review', 99999)).at(-1)).toBe('review');
  });
  it('others keep relative order', () => {
    const r = ids(reorderByDrop(S, 'frame', 99999));
    expect(r.filter((x) => x !== 'frame')).toEqual(['plan', 'verify', 'review', 'whitehat', 'commit']);
  });
  it('unknown id keeps order; input not mutated; length kept', () => {
    const before = ids(S);
    expect(ids(reorderByDrop(S, 'nope', 440))).toEqual(before);
    reorderByDrop(S, 'plan', 5 * STAGE_GAP);
    expect(ids(S)).toEqual(before);
    expect(reorderByDrop(S, 'plan', 5 * STAGE_GAP)).toHaveLength(S.length);
  });
  it('dropping at its own slot is a no-op', () => {
    expect(ids(reorderByDrop(S, 'verify', 2 * STAGE_GAP))).toEqual(ids(S));
  });
  it('single stage list', () => {
    expect(ids(reorderByDrop(mk('a'), 'a', 5000))).toEqual(['a']);
  });
});

describe('moveStage', () => {
  it('moves forward and back', () => {
    expect(ids(moveStage(mk('a', 'b', 'c', 'd'), 'a', 2))).toEqual(['b', 'c', 'a', 'd']);
    expect(ids(moveStage(mk('a', 'b', 'c', 'd'), 'd', 0))).toEqual(['d', 'a', 'b', 'c']);
  });
  it('clamps and ignores unknown ids', () => {
    expect(ids(moveStage(mk('a', 'b', 'c'), 'a', 99))).toEqual(['b', 'c', 'a']);
    expect(ids(moveStage(mk('a', 'b', 'c'), 'c', -4))).toEqual(['c', 'a', 'b']);
    expect(ids(moveStage(mk('a', 'b', 'c'), 'zz', 1))).toEqual(['a', 'b', 'c']);
  });
  it('does not mutate', () => {
    const s = mk('a', 'b');
    moveStage(s, 'a', 1);
    expect(ids(s)).toEqual(['a', 'b']);
  });
});
