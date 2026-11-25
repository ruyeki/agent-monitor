import { useEffect, useRef, useState } from 'react';

export const RUN_TABS = ['crew', 'stages', 'ledger'];

export const VIEW_IDS = ['waiting', 'active', 'finished'];

// '#/' monitor, '#/?view=<waiting|active|finished>' monitor with a view open (an unknown view is ignored), '#/workflow' editor,
// '#/stats' usage, '#/accounts' Claude accounts, '#/runs/<id>' and '#/runs/<id>/<tab>' run view (tab crew | stages | ledger;
// missing or unknown = stages, so old links keep working). Anything else (including the old '#/waiting') falls back to the monitor.
export function parseRoute(hash) {
  const path = (hash || '').replace(/^#/, '');
  const q = /^\/?\?(.*)$/.exec(path);
  if (q) {
    const view = new URLSearchParams(q[1]).get('view');
    return VIEW_IDS.includes(view) ? { name: 'monitor', view } : { name: 'monitor' };
  }
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

export const monitorHref = (view) => (view ? `#/?view=${view}` : '#/');

// ---- Back button: which page is in front of us, and how many history entries ago it was ----
// A "page key" is the route without the run tab, so switching tabs inside one run is not a page change.
export const pageKey = (r) => (r.name === 'run' ? `run:${r.id}` : r.name === 'monitor' ? `monitor:${r.view || ''}` : r.name);

// The tag stored on a history entry we land on for the first time: `prev` is the tag of the entry we came from (null on first
// load). `backSteps` counts the entries back to the last different page; 0 means no in-app history before this page.
export function nextTag(prev, key) {
  if (!prev) return { key, backSteps: 0 };
  // A tab switch on the same page: stays 0 when the page was opened directly, so Back still goes to the Monitor.
  if (prev.key === key) return { key, backSteps: prev.backSteps > 0 ? prev.backSteps + 1 : 0 };
  return { key, backSteps: 1 };
}

// Set the hash and update the route now (the browser's own hashchange follows later and changes nothing).
export function navigate(hash) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent('hashchange'));
}

// Back: past the tab switches to the page we came from, or to the Monitor when there is no in-app history.
// (The Monitor's own Back, which clears its view and search, is handled in App.jsx.)
export function goBack() {
  const steps = window.history.state?.am?.backSteps || 0;
  if (steps > 0) window.history.go(-steps);
  else navigate('#/');
}

export function useRoute() {
  const [hash, setHash] = useState(() => window.location.hash);
  const prev = useRef(null);
  useEffect(() => {
    // Tag the entry we are on (adopt a tag it already has, e.g. after browser Back or a reload) and remember it.
    const stamp = () => {
      const key = pageKey(parseRoute(window.location.hash));
      const have = window.history.state?.am;
      const tag = have && have.key === key ? have : nextTag(prev.current, key);
      if (tag !== have) window.history.replaceState({ ...window.history.state, am: tag }, '');
      prev.current = tag;
    };
    const on = () => {
      stamp();
      setHash(window.location.hash);
    };
    stamp();
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parseRoute(hash);
}
