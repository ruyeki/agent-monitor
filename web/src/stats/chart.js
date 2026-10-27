// Pure helpers for the daily chart: local day range, series split, nice axis maximum.
export const TYPE_SERIES = [
  { key: 'input', label: 'Input' },
  { key: 'output', label: 'Output' },
  { key: 'cacheWrite', label: 'Cache write' },
  { key: 'cacheRead', label: 'Cache read' },
];
const MAX_MODELS = 8;

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

const rowTotal = (r) => (r.input || 0) + (r.output || 0) + (r.cacheWrite || 0) + (r.cacheRead || 0);

// -> { series: [{key, label, slot}], columns: [{day, values: {key: n}, total}] }
// Colour slots follow the entity (models sorted by name), never its rank in the current view.
export function buildSeries(daily, mode, days) {
  let series;
  let valuesOf;
  if (mode === 'type') {
    series = TYPE_SERIES.map((s, i) => ({ ...s, slot: i }));
    valuesOf = (r) => Object.fromEntries(TYPE_SERIES.map((s) => [s.key, r[s.key] || 0]));
  } else {
    const totals = new Map();
    for (const r of daily) totals.set(r.model, (totals.get(r.model) || 0) + rowTotal(r));
    let models = [...totals.keys()];
    const overflow = models.length > MAX_MODELS;
    if (overflow) models = models.sort((a, b) => totals.get(b) - totals.get(a)).slice(0, MAX_MODELS - 1);
    models.sort();
    series = models.map((m, i) => ({ key: m, label: m, slot: i }));
    if (overflow) series.push({ key: 'Other', label: 'Other', slot: -1 });
    const known = new Set(models);
    valuesOf = (r) => ({ [known.has(r.model) ? r.model : 'Other']: rowTotal(r) });
  }
  const byDay = new Map(dayRange(days).map((d) => [d, { day: d, values: Object.fromEntries(series.map((s) => [s.key, 0])), total: 0 }]));
  for (const r of daily) {
    const col = byDay.get(r.day);
    if (!col) continue;
    for (const [k, v] of Object.entries(valuesOf(r))) {
      col.values[k] += v;
      col.total += v;
    }
  }
  return { series, columns: [...byDay.values()] };
}

// 0 -> 1, 130 -> 200, 4.2M -> 5M
export function niceMax(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
}
