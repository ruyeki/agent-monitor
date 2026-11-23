// Context window per model and how full an agent's context is. Pure.

// Longest id-prefix wins (same idea as priceFor), matched only at an id boundary; anything not listed is 200k.
// A row equal to its shorter prefix is left out (claude-opus-5 already covers claude-opus-5-5).
const WINDOWS = [
  ['claude-fable-5', 1_000_000], ['claude-opus-5', 1_000_000],
  ['claude-opus-4-8', 1_000_000], ['claude-opus-4-7', 1_000_000], ['claude-opus-4-6', 1_000_000],
  ['claude-sonnet-5', 1_000_000], ['claude-sonnet-4-6', 1_000_000],
  ['claude-haiku-5-5', 1_000_000], ['claude-haiku-4-5', 200_000],
];
export const DEFAULT_WINDOW = 200_000;

export function windowFor(model) {
  if (typeof model !== 'string') return DEFAULT_WINDOW;
  let best = null;
  for (const [prefix, size] of WINDOWS) if (model.startsWith(prefix) && /^$|^[-[@]/.test(model.slice(prefix.length)) && (!best || prefix.length > best[0].length)) best = [prefix, size];
  return best ? best[1] : DEFAULT_WINDOW;
}

// {tokens, window, pct} (pct capped at 100), or null when the token count is unknown: never a fake 0%.
export function contextOf(model, tokens) {
  if (!Number.isFinite(tokens) || tokens <= 0) return null;
  const window = windowFor(model);
  return { tokens, window, pct: Math.min(100, Math.round((100 * tokens) / window)) };
}
