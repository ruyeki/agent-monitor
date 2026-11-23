import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { getRun } from './api.js';

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

// One shared clock per period: a single interval serves every subscriber (a long Ledger has hundreds of Ago leaves),
// started with the first subscriber and stopped with the last. Read through useSyncExternalStore.
const clocks = new Map(); // ms -> {now, subs, timer}
function clockFor(ms) {
  let c = clocks.get(ms);
  if (!c) {
    c = { now: Date.now(), subs: new Set(), timer: null };
    clocks.set(ms, c);
  }
  return c;
}
function subscribeClock(ms, fn) {
  const c = clockFor(ms);
  c.subs.add(fn);
  if (c.timer == null) {
    c.now = Date.now();
    c.timer = setInterval(() => {
      c.now = Date.now();
      for (const f of [...c.subs]) f();
    }, ms);
  }
  return () => {
    c.subs.delete(fn);
    if (!c.subs.size) {
      clearInterval(c.timer);
      c.timer = null;
      clocks.delete(ms);
    }
  };
}
function clockNow(ms) {
  const c = clockFor(ms);
  // Idle clock: keep the value stable between reads, but not older than one period.
  if (c.timer == null && Date.now() - c.now >= ms) c.now = Date.now();
  return c.now;
}
export function useNow(ms) {
  const subscribe = useCallback((fn) => subscribeClock(ms, fn), [ms]);
  const get = useCallback(() => clockNow(ms), [ms]);
  return useSyncExternalStore(subscribe, get, get);
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

// The Monitor layout ('list' | 'fleet'), remembered per browser. The page works when storage throws.
const LAYOUT_KEY = 'agent-monitor-layout';
export function useLayout() {
  const [layout, setLayout] = useState(() => {
    try {
      return localStorage.getItem(LAYOUT_KEY) === 'fleet' ? 'fleet' : 'list';
    } catch {
      return 'list';
    }
  });
  const choose = useCallback((v) => {
    const next = v === 'fleet' ? 'fleet' : 'list';
    setLayout(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      /* storage blocked */
    }
  }, []);
  return [layout, choose];
}

// Run details for the Monitor rows and Fleet cards (contract C3). Live runs refetch when the throttled tick moves (SSE
// fires on every tool call); ended runs are fetched once per id@updatedAt and never again. Returns detailOf(id) -> detail | null.
export function useRunDetails(liveRuns, endedRuns, tick, ms = 3000) {
  const t = useThrottledTick(tick, ms);
  const [version, setVersion] = useState(0);
  const cache = useRef(new Map()); // id -> {key, detail}
  const pending = useRef(new Set());
  const seq = useRef(0); // request order; a slow older response must not overwrite a newer one
  const applied = useRef(new Map()); // id -> seq of the response shown
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const load = (id, key) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    const mine = ++seq.current;
    getRun(id)
      .then(
        (d) => {
          if (!alive.current || !d || typeof d !== 'object') return;
          if (mine < (applied.current.get(id) ?? 0)) return;
          applied.current.set(id, mine);
          cache.current.set(id, { key, detail: d });
          setVersion((v) => v + 1);
        },
        () => {}, // keep the last good detail
      )
      .finally(() => pending.current.delete(key));
  };
  const liveIds = liveRuns.map((r) => r.id).join('\n');
  useEffect(() => {
    for (const id of liveIds ? liveIds.split('\n') : []) load(id, `${id}#${t}`);
  }, [liveIds, t]); // eslint-disable-line react-hooks/exhaustive-deps
  const endedKeys = endedRuns.map((r) => `${r.id}@${r.updatedAt}`).join('\n');
  useEffect(() => {
    for (const r of endedRuns) {
      const key = `${r.id}@${r.updatedAt}`;
      if (cache.current.get(r.id)?.key !== key) load(r.id, key);
    }
  }, [endedKeys]); // eslint-disable-line react-hooks/exhaustive-deps
  return useCallback((id) => cache.current.get(id)?.detail ?? null, [version]); // eslint-disable-line react-hooks/exhaustive-deps
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
