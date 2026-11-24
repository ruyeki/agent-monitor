// 1234 -> "1.2k"; 2_500_000 -> "2.5M"; 1_314_800_000 -> "1.3B". The cut-offs sit where rounding would print "1000k" or "1000.0M".
export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 999_500) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  if (v < 999_950_000) return `${(v / 1_000_000).toFixed(1)}M`;
  return `${(v / 1_000_000_000).toFixed(1)}B`;
}

export function roundsLabel(run) {
  return `${run.round ?? 0}/${run.maxRounds ?? '?'}`;
}

export const isEnded = (run) => run.status === 'done' || run.status === 'stopped';

export function splitRuns(runs) {
  const waiting = [];
  const live = [];
  const finished = [];
  for (const r of runs || []) {
    if (isEnded(r)) finished.push(r);
    else if (r.status === 'waiting') waiting.push(r);
    else live.push(r);
  }
  return { waiting, live, finished };
}

// 65000 -> "1m 5s"; null -> "-"
export function formatDuration(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '-';
  const sec = Math.max(0, Math.floor(Number(ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// Compact elapsed time for rows and cards: 45_000 -> "45s"; 725_000 -> "12m"; 4_320_000 -> "1h 12m"; null -> "-"
export function formatElapsed(ms) {
  if (ms == null || Number.isNaN(Number(ms))) return '-';
  const sec = Math.max(0, Math.floor(Number(ms) / 1000));
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ${String(m % 60).padStart(2, '0')}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

// 12.345 -> "$12.35"; 0.004 -> "<$0.01"; 0 -> "$0.00"; unknown (null / undefined) -> "–", never a made-up "$0.00"
export function formatCost(n) {
  if (n == null) return '–';
  const v = Number(n) || 0;
  if (v > 0 && v < 0.01) return '<$0.01';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
