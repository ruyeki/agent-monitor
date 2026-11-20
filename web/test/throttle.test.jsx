import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useThrottledTick } from '../src/hooks.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

const setup = (ms) => renderHook(({ t }) => useThrottledTick(t, ms), { initialProps: { t: 0 } });
const advance = (ms) => act(() => vi.advanceTimersByTime(ms));

describe('useThrottledTick', () => {
  it('starts at the given tick', () => {
    expect(renderHook(() => useThrottledTick(7)).result.current).toBe(7);
  });

  it('starts a cooldown on mount: a change inside the first period waits for mount + ms', () => {
    const { result, rerender } = setup(30_000);
    advance(250);
    rerender({ t: 1 }); // e.g. the SSE onopen right after the page loaded
    expect(result.current).toBe(0);
    advance(29_749);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(1);
  });

  it('coalesces changes of the first period into one trailing update at mount + ms', () => {
    const { result, rerender } = setup(30_000);
    advance(5000);
    rerender({ t: 1 });
    advance(5000);
    rerender({ t: 2 });
    expect(result.current).toBe(0);
    advance(19_999);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(2); // the latest value only
  });

  it('passes a change at once after a quiet period of ms (leading edge)', () => {
    const { result, rerender } = setup(1000);
    advance(1000);
    rerender({ t: 1 });
    expect(result.current).toBe(1);
  });

  it('applies the trailing update only once, then throttles again from it', () => {
    const { result, rerender } = setup(1000);
    const seen = [];
    rerender({ t: 1 });
    rerender({ t: 2 });
    advance(1000);
    seen.push(result.current);
    rerender({ t: 3 }); // inside the new period started by the trailing update
    expect(result.current).toBe(2);
    advance(1000);
    expect(result.current).toBe(3);
    expect(seen).toEqual([2]);
  });

  it('passes the next change at once after a quiet period following a pass', () => {
    const { result, rerender } = setup(1000);
    advance(1000);
    rerender({ t: 1 });
    advance(1000);
    rerender({ t: 2 });
    expect(result.current).toBe(2);
  });

  it('does nothing when the tick returns to what is shown', () => {
    const { result, rerender } = setup(1000);
    advance(1000);
    rerender({ t: 1 });
    rerender({ t: 2 });
    rerender({ t: 1 });
    advance(1000);
    expect(result.current).toBe(1);
  });

  it('clears its timer on unmount', () => {
    const { rerender, unmount } = setup(1000);
    rerender({ t: 1 });
    rerender({ t: 2 });
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('defaults to 30 seconds', () => {
    const { result, rerender } = renderHook(({ t }) => useThrottledTick(t), { initialProps: { t: 0 } });
    rerender({ t: 1 });
    advance(29_999);
    expect(result.current).toBe(0);
    advance(1);
    expect(result.current).toBe(1);
  });
});
