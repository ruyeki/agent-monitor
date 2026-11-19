// Usage maths for Claude accounts: % used per window, usage left, limits, the best account and attribution. Pure functions.
// A window is {used_percentage 0..100, resets_at epoch s}; a limit is {at ISO, resetsAt epoch s|null}; now is epoch ms.

export const LIMIT_FALLBACK_MS = 5 * 3600_000;
const clamp = (v) => Math.min(100, Math.max(0, v));

// Epoch seconds from epoch s, epoch ms, an ISO string or a Date; null when there is none.
export function toSecs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? Math.round(v > 1e12 ? v / 1000 : v) : null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}

// Epoch ms from epoch ms, an ISO string or a Date; null when there is none.
export function toMs(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const ms = v instanceof Date ? v.getTime() : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// A statusline window -> {used_percentage, resets_at} or null.
export function normWindow(w) {
  if (!w || typeof w !== 'object' || typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null;
  return { used_percentage: w.used_percentage, resets_at: Number.isFinite(w.resets_at) ? w.resets_at : null };
}

// A stream-json rate_limit_info -> {five_hour, seven_day} windows (utilization 0..1 -> percent).
export function fromRateLimitInfo(info) {
  const out = { five_hour: null, seven_day: null };
  const win = (w) => (w && Number.isFinite(w.utilization)
    ? { used_percentage: Math.round(w.utilization * 10000) / 100, resets_at: Number.isFinite(w.resetsAt) ? w.resetsAt : null } : null);
  const uw = info?.unifiedWindows;
  if (uw && typeof uw === 'object') { out.five_hour = win(uw.five_hour); out.seven_day = win(uw.seven_day); }
  else if (info?.rateLimitType in out) out[info.rateLimitType] = win(info);
  return out;
}

// 0 when the window is absent or has reset, else its clamped %.
export function windowPct(w, now) {
  if (!w || !Number.isFinite(w.used_percentage)) return 0;
  if (Number.isFinite(w.resets_at) && w.resets_at * 1000 <= now) return 0;
  return clamp(w.used_percentage);
}

// 100 minus the higher window; an account with no reading is fully available.
export function usageLeft(reading, now) {
  if (!reading) return 100;
  return 100 - Math.max(windowPct(reading.five_hour, now), windowPct(reading.seven_day, now));
}

// Epoch ms until which a limit hit blocks the account: its reset time, or 5 h after the hit when that is missing or not later.
export function limitedUntil(limit) {
  if (!limit) return null;
  const at = toMs(limit.at);
  if (at == null) return null;
  return Number.isFinite(limit.resetsAt) && limit.resetsAt * 1000 > at ? limit.resetsAt * 1000 : at + LIMIT_FALLBACK_MS;
}

// accounts: [{name, saved, usage: {reading, limit}}]
export function isAvailable(a, now) {
  if (!a?.saved) return false;
  const until = limitedUntil(a.usage?.limit);
  if (until != null && now < until) return false;
  return usageLeft(a.usage?.reading, now) > 0;
}

// The available, non-excluded account with the most usage left (ties: name ascending), or null.
export function pickBest(accounts, now, exclude = []) {
  const skip = new Set(exclude);
  let best = null;
  let bestLeft = -1;
  for (const a of [...accounts].sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0))) {
    if (skip.has(a.name) || !isAvailable(a, now)) continue;
    const left = usageLeft(a.usage?.reading, now);
    if (left > bestLeft) { best = a.name; bestLeft = left; }
  }
  return best;
}

// The account a reading or hit belongs to: a registered account other than the active one whose stored window
// resets_at or limit resetsAt equals secs exactly; else the active account. usages: {name: {reading, limit}}.
export function attribute(names, active, usages, secs) {
  if (secs == null) return active;
  const stored = (u) => [u?.reading?.five_hour?.resets_at, u?.reading?.seven_day?.resets_at, u?.limit?.resetsAt];
  const other = [...names].sort().find((n) => n !== active && stored(usages[n]).includes(secs));
  return other ?? active;
}
