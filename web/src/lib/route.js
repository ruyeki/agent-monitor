import { useEffect, useState } from 'react';

export const RUN_TABS = ['crew', 'stages', 'ledger'];

// '#/' monitor, '#/workflow' editor, '#/stats' usage, '#/accounts' Claude accounts, '#/runs/<id>' and '#/runs/<id>/<tab>' run view (tab crew | stages |
// ledger; missing or unknown = stages, so old links keep working). Anything else (including the old '#/waiting') falls back to the monitor.
export function parseRoute(hash) {
  const path = (hash || '').replace(/^#/, '');
  if (path === '/workflow') return { name: 'workflow' };
  if (path === '/stats') return { name: 'stats' };
  if (path === '/accounts') return { name: 'accounts' };
  const m = /^\/runs\/([^/]+)(?:\/([^/]*))?$/.exec(path);
  if (m) {
    try {
      return { name: 'run', id: decodeURIComponent(m[1]), tab: RUN_TABS.includes(m[2]) ? m[2] : 'stages' };
    } catch {
      /* malformed escape: monitor */
    }
  }
  return { name: 'monitor' };
}

export const runHref = (id, tab) => `#/runs/${encodeURIComponent(id)}${tab ? `/${tab}` : ''}`;

export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseRoute(hash);
}
