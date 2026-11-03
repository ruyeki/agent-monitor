import { useEffect, useState } from 'react';
import { getVersionStats } from '../api.js';

// Per-version stats for the editor's node lines; null until loaded, and again when the fetch fails (no line shown).
// Refetches on every live tick and when the published version changes.
export function useVersionStats(tick, version) {
  const [stats, setStats] = useState(null);
  useEffect(() => {
    let live = true;
    getVersionStats()
      .then((list) => live && setStats(Array.isArray(list) ? list : null))
      .catch(() => live && setStats(null));
    return () => {
      live = false;
    };
  }, [tick, version]);
  return stats;
}
