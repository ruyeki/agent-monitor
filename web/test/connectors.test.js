import { describe, expect, it } from 'vitest';
import { barSpan } from '../src/lib/connectors.js';

// kid = { x, linked }: x is the child's centre, linked = it has a recorded parent (so it has a stub).
describe('barSpan (crew tree elbow)', () => {
  it('one linked child: the bar runs from the parent centre to that child, whichever side it is on', () => {
    expect(barSpan(100, [{ x: 40, linked: true }])).toEqual({ left: 40, right: 100 });
    expect(barSpan(100, [{ x: 160, linked: true }])).toEqual({ left: 100, right: 160 });
    expect(barSpan(100, [{ x: 100, linked: true }])).toEqual({ left: 100, right: 100 });
  });
  it('two and three linked children: the bar covers the parent centre and the farthest children', () => {
    expect(barSpan(150, [{ x: 50, linked: true }, { x: 250, linked: true }])).toEqual({ left: 50, right: 250 });
    expect(barSpan(150, [{ x: 50, linked: true }, { x: 150, linked: true }, { x: 250, linked: true }])).toEqual({ left: 50, right: 250 });
    expect(barSpan(120, [{ x: 40, linked: true }, { x: 110, linked: true }, { x: 180, linked: true }])).toEqual({ left: 40, right: 180 });
  });
  it('a linked child that is not first: unknown-parent children around it do not extend the bar', () => {
    expect(barSpan(200, [{ x: 40, linked: false }, { x: 130, linked: true }, { x: 260, linked: false }])).toEqual({ left: 130, right: 200 });
    expect(barSpan(100, [{ x: 20, linked: false }, { x: 180, linked: true }])).toEqual({ left: 100, right: 180 });
  });
  it('no linked child (or nothing measurable): no bar', () => {
    expect(barSpan(100, [{ x: 20, linked: false }, { x: 180, linked: false }])).toBeNull();
    expect(barSpan(100, [])).toBeNull();
    expect(barSpan(100, undefined)).toBeNull();
    expect(barSpan(NaN, [{ x: 1, linked: true }])).toBeNull();
    expect(barSpan(100, [{ x: NaN, linked: true }])).toBeNull();
  });
});
