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

// The models shown by the line chart and the spend donut: top MAX_SERIES by the metric, best first, plus an 'Other' entry
// (slot -1, `count` = folded models) when more than MAX_SERIES have data. A visible model with no slot takes the lowest free one.
// -> [{ key, label, slot, cost, tokens, count? }]
export function topModels(rows, metric, slots = modelSlots(rows)) {
  const ranked = rankByMetric(totalsByModel(rows), metric);
  const top = ranked.slice(0, MAX_SERIES);
  const used = new Set(top.map((t) => slots.get(t.label)).filter((s) => s !== undefined));
  const out = top.map((t) => {
    let slot = slots.get(t.label);
    if (slot === undefined) {
      slot = 0;
      while (used.has(slot)) slot++;
      used.add(slot);
    }
    return { key: t.label, label: t.label, slot, cost: t.cost, tokens: t.tokens };
  });
  const rest = ranked.slice(MAX_SERIES);
  if (rest.length) out.push({ key: 'Other', label: 'Other', slot: -1, count: rest.length, cost: rest.reduce((n, t) => n + t.cost, 0), tokens: rest.reduce((n, t) => n + t.tokens, 0) });
  return out;
}

// Series of the daily chart for the last `days` days -> { series: [{key, label, slot}], columns: [{day, values, total}], total }
// Series are in rank order, rank 1 first; Other (slot -1) last.
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
    const top = topModels(rows, metric, slots);
    series = top.map(({ key, label, slot }) => ({ key, label, slot }));
    const known = new Set(top.filter((t) => t.key !== 'Other').map((t) => t.key));
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

// Largest single-series value on any day: lines are not stacked, so this sets the y axis.
export const maxSeriesValue = (columns) => Math.max(0, ...columns.flatMap((c) => Object.values(c.values)));

// One point per column centre; a day with no value is 0. `plot` = { left, step, top, height, max } (y grows downwards).
export function linePoints(values, { left, step, top, height, max }) {
  return values.map((v, i) => ({ x: left + (i + 0.5) * step, y: top + height - ((Number(v) || 0) / max) * height }));
}

// "M x y L x y ..." for a polyline
export const linePath = (points) => points.map((p, i) => `${i ? 'L' : 'M'}${+p.x.toFixed(2)} ${+p.y.toFixed(2)}`).join(' ');

// Slice angles in degrees, clockwise from 12 o'clock, for a donut. Zero values get no angle; a positive value never gets
// less than `minDeg` (a sliver you can still hover) and the rest shrink so the angles still add up to 360.
// -> [{ start, end }]
export function sliceAngles(values, minDeg = 1) {
  const vs = values.map((v) => (v > 0 ? v : 0));
  const total = vs.reduce((n, v) => n + v, 0);
  if (total <= 0) return vs.map(() => ({ start: 0, end: 0 }));
  const small = vs.map((v) => v > 0 && (v / total) * 360 < minDeg);
  const bigSum = vs.reduce((n, v, i) => (small[i] ? n : n + v), 0);
  const room = 360 - small.filter(Boolean).length * minDeg;
  let at = 0;
  return vs.map((v, i) => {
    const deg = small[i] ? minDeg : bigSum > 0 ? (v / bigSum) * room : 0;
    const out = { start: at, end: at + deg };
    at += deg;
    return out;
  });
}

// SVG path of a ring segment between two angles (degrees clockwise from 12 o'clock). A full circle takes two arcs per edge.
export function arcPath(cx, cy, outer, inner, start, end) {
  const pt = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return [+(cx + r * Math.sin(a)).toFixed(3), +(cy - r * Math.cos(a)).toFixed(3)];
  };
  const [ox0, oy0] = pt(outer, start);
  const [ix0, iy0] = pt(inner, start);
  if (end - start >= 359.999) {
    const [ox1, oy1] = pt(outer, start + 180);
    const [ix1, iy1] = pt(inner, start + 180);
    return `M${ox0} ${oy0} A${outer} ${outer} 0 1 1 ${ox1} ${oy1} A${outer} ${outer} 0 1 1 ${ox0} ${oy0} Z M${ix0} ${iy0} A${inner} ${inner} 0 1 0 ${ix1} ${iy1} A${inner} ${inner} 0 1 0 ${ix0} ${iy0} Z`;
  }
  const [ox1, oy1] = pt(outer, end);
  const [ix1, iy1] = pt(inner, end);
  const large = end - start > 180 ? 1 : 0;
  return `M${ox0} ${oy0} A${outer} ${outer} 0 ${large} 1 ${ox1} ${oy1} L${ix1} ${iy1} A${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
}

export const MAX_STAGE_SLICES = 7; // stage slices on the tokens donut; the rest fold into "Other stages"
const stageShown = (n) => n.runs > 0 && (n.avgTokens > 0 || n.avgDurationMs > 0);
// what a stage costs one run of the version: its average over the runs that reached it, spread over every finished run
const perRun = (n, key, v) => ((n[key] || 0) * n.runs) / v.finishedRuns;

// Colour slot of each stage of a version: ranked by per-run cost (ties: per-run tokens, then workflow order) -> slots 0..7. id -> slot
export function stageSlots(version) {
  const nodes = (version?.nodes || []).filter(stageShown).map((n, i) => ({ n, i }));
  nodes.sort((a, b) => perRun(b.n, 'avgCost', version) - perRun(a.n, 'avgCost', version) || perRun(b.n, 'avgTokens', version) - perRun(a.n, 'avgTokens', version) || a.i - b.i);
  return new Map(nodes.slice(0, MAX_SLOTS).map(({ n }, i) => [n.id, i]));
}

// Slices of "Where a run's tokens go" for one version with finished runs -> { total, slices }
// total = the version's average per run for the metric. Slices in workflow order: each shown stage's per-run contribution,
// at most MAX_STAGE_SLICES of them (the largest MAX_STAGE_SLICES-1 plus "Other stages" after the last stage), then
// "Not tied to a stage" (the rest of the average) when that is more than 0.5% of it. A stage with nothing in the metric
// stays in the list with value 0 (no arc is drawn for it).
// -> slice { key, label, value, cost, tokens, slot, color, node? }
export function stageSlices(version, metric) {
  const key = metric === 'cost' ? 'avgCost' : 'avgTokens';
  const total = num(version?.[key]);
  const slotOf = stageSlots(version);
  const stages = (version?.nodes || []).filter(stageShown).map((n, i) => ({ n, i, value: perRun(n, key, version) }));
  const live = stages.filter((s) => s.value > 0);
  let folded = new Set();
  if (live.length > MAX_STAGE_SLICES) {
    const keep = [...live].sort((a, b) => b.value - a.value || a.i - b.i).slice(0, MAX_STAGE_SLICES - 1);
    folded = new Set(live.filter((s) => !keep.includes(s)));
  }
  const taken = new Set(stages.filter((s) => !folded.has(s) && slotOf.has(s.n.id)).map((s) => slotOf.get(s.n.id)));
  const slices = [];
  for (const s of stages) {
    if (folded.has(s)) continue;
    let slot = slotOf.get(s.n.id);
    if (slot === undefined) {
      slot = 0;
      while (taken.has(slot)) slot++;
      taken.add(slot);
      if (slot >= MAX_SLOTS) slot = -1; // more stages than colours: the neutral one
    }
    slices.push({ key: s.n.id, label: s.n.name || s.n.id, value: s.value, cost: perRun(s.n, 'avgCost', version), tokens: perRun(s.n, 'avgTokens', version), slot, color: seriesColor(slot), node: s.n });
  }
  if (folded.size) {
    const f = [...folded];
    slices.push({ key: 'other-stages', label: 'Other stages', value: f.reduce((n, s) => n + s.value, 0), cost: f.reduce((n, s) => n + perRun(s.n, 'avgCost', version), 0), tokens: f.reduce((n, s) => n + perRun(s.n, 'avgTokens', version), 0), slot: -1, color: seriesColor(-1), count: f.length });
  }
  const rest = total - stages.reduce((n, s) => n + s.value, 0);
  if (total > 0 && rest > total * 0.005) {
    const otherKey = metric === 'cost' ? 'avgTokens' : 'avgCost';
    const restOther = Math.max(0, num(version?.[otherKey]) - stages.reduce((n, s) => n + perRun(s.n, otherKey, version), 0));
    slices.push({ key: 'not-staged', label: 'Not tied to a stage', value: rest, cost: metric === 'cost' ? rest : restOther, tokens: metric === 'cost' ? restOther : rest, slot: -2, color: 'var(--border-strong)' });
  }
  return { total, slices };
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
