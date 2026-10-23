import { useCallback, useEffect, useRef, useState } from 'react';

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
      return localStorage.getItem(KEY) || 'system';
    } catch {
      return 'system';
    }
  });
  useEffect(() => {
    const el = document.documentElement;
    if (theme === 'system') el.removeAttribute('data-theme');
    else el.setAttribute('data-theme', theme);
    try {
      localStorage.setItem(KEY, theme);
    } catch {
      /* storage blocked */
    }
  }, [theme]);
  const cycle = useCallback(() => setTheme((t) => (t === 'system' ? 'light' : t === 'light' ? 'dark' : 'system')), []);
  return [theme, cycle];
}
