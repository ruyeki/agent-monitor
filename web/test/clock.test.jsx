// The shared clock: one interval per period for any number of subscribers, started on the first and stopped on the last.
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Ago } from '../src/Ago.jsx';
import { useNow } from '../src/hooks.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup(); // unmount while the fake timers are still installed
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function Probe({ ms }) {
  return <span>{useNow(ms)}</span>;
}

describe('useNow (shared clock)', () => {
  it('runs one interval for many subscribers and clears it when the last one leaves', () => {
    const set = vi.spyOn(globalThis, 'setInterval');
    const clear = vi.spyOn(globalThis, 'clearInterval');
    const a = render(<><Probe ms={1000} /><Probe ms={1000} /><Probe ms={1000} /></>);
    const b = render(<Ago at={new Date().toISOString()} />);
    expect(set.mock.calls.filter(([, ms]) => ms === 1000)).toHaveLength(1);
    a.unmount();
    expect(clear).not.toHaveBeenCalled(); // Ago still listens
    b.unmount();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('updates every subscriber on each tick, and a different period gets its own interval', () => {
    const { container } = render(<><Probe ms={1000} /><Probe ms={1000} /><Probe ms={5000} /></>);
    const spans = () => [...container.querySelectorAll('span')].map((s) => Number(s.textContent));
    const [a0, , c0] = spans();
    act(() => { vi.advanceTimersByTime(1000); });
    const [a1, b1, c1] = spans();
    expect(a1).toBe(a0 + 1000);
    expect(b1).toBe(a1);
    expect(c1).toBe(c0);
    expect(vi.getTimerCount()).toBe(2);
  });
});
