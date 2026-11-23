import { useEffect, useState } from 'react';
import { formatElapsed } from './lib/format.js';
import { idleTime, relativeTime, toMs } from './lib/time.js';

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

function LiveElapsed({ from }) {
  return formatElapsed(useNow(1000) - toMs(from));
}

// Run time, compact ("12m", "1h 05m"): from..to, or still counting while `to` is empty.
export function Elapsed({ from, to }) {
  if (toMs(from) == null) return '-';
  return to ? formatElapsed(toMs(to) - toMs(from)) : <LiveElapsed from={from} />;
}
