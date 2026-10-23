import { useEffect, useState } from 'react';
import { idleTime, relativeTime } from './lib/time.js';

// Only these small leaves tick, so the rest of the tree does not re-render every second.
function useNow(ms) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function Ago({ at }) {
  return relativeTime(at, useNow(1000));
}

export function Idle({ since }) {
  return idleTime(since, useNow(1000));
}
