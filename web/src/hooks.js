import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// EventSource with manual reconnect; calls onChange (debounced) on every event and on (re)open.
export function useLive(onChange, { debounce = 250, retry = 2000 } = {}) {
  const [state, setState] = useState('connecting');
  const cb = useRef(onChange);
  cb.current = onChange;
  useEffect(() => {
    let es;
    let closed = false;
    let timer;
    let retryTimer;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), debounce);
    };
    const connect = () => {
      es = new EventSource('/api/events');
      es.onopen = () => {
        setState('live');
        fire();
      };
      es.onmessage = fire;
      es.onerror = () => {
        setState('reconnecting');
        if (es.readyState === 2 && !closed) {
          es.close();
          retryTimer = setTimeout(connect, retry);
        }
      };
    };
    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      clearTimeout(retryTimer);
      es.close();
    };
  }, [debounce, retry]);
  return state;
}

const KEY = 'agent-monitor-theme';
export function useTheme() {
  const [theme, setTheme] = useState(() => {
    try {
      return localStorage.getItem(KEY) || 'dark';
    } catch {
      return 'dark';
    }
  });
  useLayoutEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);
  const cycle = useCallback(() => setTheme((t) => (t === 'dark' ? 'light' : t === 'light' ? 'system' : 'dark')), []);
  return [theme, cycle];
}

// Follows `tick` at most once per `ms`. Mounting starts the first period (as if a value had just passed), so the
// page's own first load is not repeated by the first live event. A change inside a period coalesces into one trailing
// update when it ends; the first change after a quiet period passes at once. Timer-only; cleared on unmount.
export function useThrottledTick(tick, ms = 30000) {
  const [value, setValue] = useState(tick);
  const s = useRef({ shown: tick, latest: tick, cooling: false, pending: false, timer: null, pass: null });
  useEffect(() => {
    const st = s.current;
    const cool = () => {
      st.cooling = true;
      st.timer = setTimeout(() => {
        if (st.pending) {
          st.pending = false;
          st.pass(st.latest);
        } else st.cooling = false;
      }, ms);
    };
    st.pass = (t) => {
      st.shown = t;
      setValue(t);
      cool();
    };
    cool();
    return () => {
      clearTimeout(st.timer);
      st.cooling = false;
      st.pending = false;
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const st = s.current;
    st.latest = tick;
    if (tick === st.shown) st.pending = false;
    else if (st.cooling) st.pending = true;
    else st.pass(tick);
  }, [tick]);
  return value;
}
