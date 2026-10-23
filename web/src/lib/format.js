export function formatTokens(n) {
  const v = Number(n) || 0;
  if (v < 1000) return String(v);
  if (v < 1_000_000) return `${(v / 1000).toFixed(v < 10_000 ? 1 : 0)}k`;
  return `${(v / 1_000_000).toFixed(1)}M`;
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
    else {
      live.push(r);
      if (r.status === 'waiting') waiting.push(r);
    }
  }
  return { waiting, live, finished };
}
