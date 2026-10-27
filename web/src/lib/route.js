import { useEffect, useState } from 'react';

// '#/' monitor, '#/workflow' editor, '#/runs/<id>' run view, '#/stats' usage. Anything else falls back to the monitor.
export function parseRoute(hash) {
  const path = (hash || '').replace(/^#/, '');
  if (path === '/workflow') return { name: 'workflow' };
  if (path === '/stats') return { name: 'stats' };
  const m = /^\/runs\/([^/]+)$/.exec(path);
  if (m) {
    try {
      return { name: 'run', id: decodeURIComponent(m[1]) };
    } catch {
      /* malformed escape: monitor */
    }
  }
  return { name: 'monitor' };
}

export const runHref = (id) => `#/runs/${encodeURIComponent(id)}`;

export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseRoute(hash);
}
