// Model price table (USD per million tokens). Everything derived from it is an estimate.

const row = (model, input, output, cacheWrite, cacheWrite1h, cacheRead, note = '') =>
  ({ model, input, output, cacheWrite, cacheWrite1h, cacheRead, note });

export const SEED_PRICES = [
  row('claude-fable-5-1', 10, 50, 12.5, 20, 0.25),
  row('claude-fable-5', 10, 50, 12.5, 20, 1),
  row('claude-opus-5-5', 4, 20, 5, 8, 0.2),
  row('claude-opus-5', 5, 25, 6.25, 10, 0.5),
  row('claude-opus-4-8', 5, 25, 6.25, 10, 0.5),
  row('claude-opus-4-7', 5, 25, 6.25, 10, 0.5),
  row('claude-opus-4-6', 5, 25, 6.25, 10, 0.5),
  row('claude-sonnet-5-5', 2, 10, 2.5, 4, 0.2),
  row('claude-sonnet-5', 2, 10, 2.5, 4, 0.2),
  row('claude-sonnet-4-6', 3, 15, 3.75, 6, 0.3),
  row('claude-haiku-5-5', 0.1, 0.5, 0.125, 0.2, 0.01, 'Rates apply to prompts up to 100K tokens.'),
  row('claude-haiku-4-5', 1, 5, 1.25, 2, 0.1),
];

const RATE_KEYS = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'];
const MAX_PRICE_ROWS = 100;

// Longest id-prefix match, so 'claude-opus-5-5-x' picks 'claude-opus-5-5', not 'claude-opus-5'.
export function priceFor(rows, model) {
  if (typeof model !== 'string') return null;
  let best = null;
  for (const r of rows ?? []) {
    if (model.startsWith(r.model) && (!best || r.model.length > best.model.length)) best = r;
  }
  return best;
}

// row.cacheWrite is the total of both cache-write tiers; cacheWrite1h is the 1h part of it.
export function costOf(row, price) {
  if (!price) return null;
  const n = (v) => Number(v) || 0;
  return (n(row.input) * price.input + n(row.output) * price.output
    + (n(row.cacheWrite) - n(row.cacheWrite1h)) * price.cacheWrite
    + n(row.cacheWrite1h) * price.cacheWrite1h + n(row.cacheRead) * price.cacheRead) / 1e6;
}

// Returns {rows} (cleaned) or {error}.
export function validatePrices(rows) {
  if (!Array.isArray(rows)) return { error: 'Prices must be a list.' };
  if (rows.length > MAX_PRICE_ROWS) return { error: `At most ${MAX_PRICE_ROWS} price rows.` };
  const seen = new Set();
  const clean = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') return { error: 'Each price row must be an object.' };
    if (typeof r.model !== 'string' || !r.model || r.model.length > 80) return { error: 'Model prefix must be a non-empty string of at most 80 characters.' };
    if (seen.has(r.model)) return { error: `Duplicate model prefix '${r.model}'.` };
    seen.add(r.model);
    for (const k of RATE_KEYS) {
      if (typeof r[k] !== 'number' || !Number.isFinite(r[k]) || r[k] < 0) return { error: `'${k}' for '${r.model}' must be a non-negative number.` };
    }
    if (r.note != null && (typeof r.note !== 'string' || r.note.length > 500)) return { error: `Note for '${r.model}' must be a string of at most 500 characters.` };
    clean.push({ model: r.model, ...Object.fromEntries(RATE_KEYS.map((k) => [k, r[k]])), note: r.note ?? '' });
  }
  return { rows: clean };
}
