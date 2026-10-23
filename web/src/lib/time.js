// The API sends ISO strings only.
export function toMs(v) {
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

function span(sec) {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// "just now", "42s ago", "5m ago", "3h ago", "2d ago"
export function relativeTime(v, now = Date.now()) {
  const t = toMs(v);
  if (t == null) return '-';
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Idle duration, ticking to the second: "7s", "2m 5s".
export function idleTime(v, now = Date.now()) {
  const t = toMs(v);
  if (t == null) return '-';
  return span(Math.max(0, Math.floor((now - t) / 1000)));
}
