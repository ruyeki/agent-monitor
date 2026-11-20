// Pure helpers for the Stats page: local days, model labels, series split, colour slots, axis ticks, delta, runs summary.
export const TYPE_SERIES = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
];
export const MAX_SERIES = 5; // named model series on the daily chart; the rest fold into Other
export const MAX_SLOTS = 8;

export const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// the last `days` local days ending today, oldest first
export function dayRange(days, now = new Date()) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(localDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)));
  return out;
}

// 'YYYY-MM-DD' -> "Oct 27" (a local calendar date, never shifted by a timezone)
export function dayLabel(day) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// "claude-opus-5-5-20261001" -> "Opus 5.5"; anything that is not a claude-<family>-<major>... id stays as it is
const MODEL_ID = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?(?:[-[].*)?$/;
export function shortModel(id) {
  const m = typeof id === 'string' ? MODEL_ID.exec(id) : null;
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}

const num = (v) => Number(v) || 0;
export const rowTokens = (r) => num(r.input) + num(r.output) + num(r.cacheWrite) + num(r.cacheRead);
export const metricValue = (r, metric) => (metric === 'cost' ? num(r.cost) : rowTokens(r));
export const modelLabel = (r) => shortModel(r.model || 'unknown');

// label -> { cost, tokens } over the given rows, in no particular order
export function totalsByModel(rows) {
  const by = new Map();
  for (const r of rows) {
    const label = modelLabel(r);
    const t = by.get(label) ?? { label, cost: 0, tokens: 0 };
    t.cost += num(r.cost);
    t.tokens += rowTokens(r);
    by.set(label, t);
  }
  return [...by.values()];
}

// Models that have data, best first by the selected metric (ties: the other metric, then the label).
export function rankByMetric(totals, metric) {
  const [a, b] = metric === 'cost' ? ['cost', 'tokens'] : ['tokens', 'cost'];
  return totals.filter((t) => t.cost > 0 || t.tokens > 0).sort((x, y) => y[a] - x[a] || y[b] - x[b] || x.label.localeCompare(y.label));
}

// Colour slots follow the model, not the view: every model of the fetched response ranked by cost (ties: tokens, label).
// label -> slot index 0..7; models beyond the eighth have none.
export function modelSlots(daily) {
  const ranked = totalsByModel(daily).sort((x, y) => y.cost - x.cost || y.tokens - x.tokens || x.label.localeCompare(y.label));
  return new Map(ranked.slice(0, MAX_SLOTS).map((t, i) => [t.label, i]));
}

// CSS colour of a series slot: --series-1..8, or --series-other for no slot / Other.
export const seriesColor = (slot) => (slot === undefined || slot < 0 ? 'var(--series-other)' : `var(--series-${slot + 1})`);

// Series of the daily chart for the last `days` days -> { series: [{key, label, slot}], columns: [{day, values, total}], total }
// Stack order = rank order, rank 1 at the baseline; Other (slot -1) last. A visible model with no slot takes the lowest free one.
export function buildSeries(daily, { split = 'model', metric = 'cost', days, slots = modelSlots(daily), now = new Date() }) {
  const shown = dayRange(days, now);
  const inRange = new Set(shown);
  const rows = daily.filter((r) => inRange.has(r.day));
  let series;
  let keyOf = null;
  let valueOf;
  if (split === 'type') {
    series = TYPE_SERIES.map((s, i) => ({ ...s, slot: i }));
    valueOf = (r, key) => (metric === 'cost' ? num(r.costs?.[key]) : num(r[key]));
  } else {
    const ranked = rankByMetric(totalsByModel(rows), metric);
    const top = ranked.slice(0, MAX_SERIES);
    const used = new Set(top.map((t) => slots.get(t.label)).filter((s) => s !== undefined));
    series = top.map((t) => {
      let slot = slots.get(t.label);
      if (slot === undefined) {
        slot = 0;
        while (used.has(slot)) slot++;
        used.add(slot);
      }
      return { key: t.label, label: t.label, slot };
    });
    if (ranked.length > MAX_SERIES) series.push({ key: 'Other', label: 'Other', slot: -1 });
    const known = new Set(top.map((t) => t.label));
    keyOf = (r) => (known.has(modelLabel(r)) ? modelLabel(r) : 'Other');
    valueOf = (r) => metricValue(r, metric);
  }
  const byDay = new Map(shown.map((d) => [d, { day: d, values: Object.fromEntries(series.map((s) => [s.key, 0])), total: 0 }]));
  for (const r of rows) {
    const col = byDay.get(r.day);
    const parts = keyOf ? [[keyOf(r), valueOf(r)]] : series.map((s) => [s.key, valueOf(r, s.key)]);
    for (const [k, v] of parts) {
      col.values[k] += v;
      col.total += v;
    }
  }
  const columns = [...byDay.values()];
  return { series, columns, total: columns.reduce((n, c) => n + c.total, 0) };
}

// Axis ticks [0, s, ..., k*s] with k 3 or 4 (4-5 gridlines), s in {1, 2, 2.5, 5} x 10^n and k*s >= max; max <= 0 counts as 1.
// `integer` keeps s a whole number (for counts).
export function niceTicks(max, { integer = false } = {}) {
  const m = max > 0 ? max : 1;
  let p = 10 ** (Math.floor(Math.log10(m / 4)) - 1);
  for (;;) {
    for (const f of [1, 2, 2.5, 5]) {
      const s = f * p;
      if (integer && !Number.isInteger(s)) continue;
      if (4 * s >= m * (1 - 1e-9)) {
        const k = m <= 3 * s * (1 + 1e-9) ? 3 : 4;
        return Array.from({ length: k + 1 }, (_, i) => +(i * s).toPrecision(12));
      }
    }
    p *= 10;
  }
}

// $0, $50, $0.25, $1.5k
export function compactCost(v) {
  if (v >= 1000) return `$${+(v / 1000).toFixed(1)}k`;
  return `$${+v.toFixed(2)}`;
}

// 0.4 -> "0.4%", 12.6 -> "13%", 0 -> "0%"
export function shareLabel(pct) {
  if (!(pct > 0)) return '0%';
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

// Change of the shown period against the one before it. Rows must cover 2 x `range` days.
// -> { kind: 'up' | 'down' | 'same' | 'nodata' | 'nothing', text }
export function periodDelta(daily, { metric, range, firstDay, now = new Date() }) {
  const all = dayRange(range * 2, now);
  const prevDays = new Set(all.slice(0, range));
  const curDays = new Set(all.slice(range));
  let cur = 0;
  let prev = 0;
  for (const r of daily) {
    if (curDays.has(r.day)) cur += metricValue(r, metric);
    else if (prevDays.has(r.day)) prev += metricValue(r, metric);
  }
  const label = `the previous ${range} days`;
  if (firstDay === null || (typeof firstDay === 'string' && firstDay > all[0])) return { kind: 'nodata', text: `No data for ${label}` };
  if (prev <= 0) return { kind: 'nothing', text: `Nothing in ${label}` };
  const pct = Math.round((Math.abs(cur - prev) / prev) * 100);
  if (pct === 0) return { kind: 'same', text: `No change vs previous ${range} days` };
  return cur > prev ? { kind: 'up', text: `▲ ${pct}% vs previous ${range} days` } : { kind: 'down', text: `▼ ${pct}% vs previous ${range} days` };
}

// Runs started in the last `days` days (by local creation day): per-day counts, outcome counts, median duration and mean fix rounds of the finished ones.
export function summarizeRuns(runs, days, now = new Date()) {
  const shown = dayRange(days, now);
  const counts = new Map(shown.map((d) => [d, 0]));
  const outcomes = { finished: 0, stopped: 0, open: 0 };
  const durations = [];
  const rounds = [];
  let total = 0;
  for (const r of runs || []) {
    const created = new Date(r.createdAt);
    const day = Number.isNaN(created.getTime()) ? null : localDay(created);
    if (!counts.has(day)) continue;
    counts.set(day, counts.get(day) + 1);
    total++;
    if (r.status === 'done') {
      outcomes.finished++;
      const ms = Date.parse(r.endedAt) - created.getTime();
      if (Number.isFinite(ms)) durations.push(ms);
      rounds.push(num(r.round));
    } else if (r.status === 'stopped') outcomes.stopped++;
    else outcomes.open++;
  }
  durations.sort((a, b) => a - b);
  const mid = durations.length >> 1;
  const medianMs = durations.length ? (durations.length % 2 ? durations[mid] : (durations[mid - 1] + durations[mid]) / 2) : null;
  const avgRounds = rounds.length ? rounds.reduce((a, b) => a + b, 0) / rounds.length : null;
  return { perDay: shown.map((d) => ({ day: d, count: counts.get(d) })), total, outcomes, medianMs, avgRounds };
}

// A remembered choice from localStorage; anything missing, invalid or unreadable gives the default.
export function readChoice(key, allowed, fallback) {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
export function writeChoice(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* storage blocked */
  }
}
