import { useNow } from './hooks.js';
import { formatElapsed } from './lib/format.js';
import { idleTime, relativeTime, toMs } from './lib/time.js';

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
