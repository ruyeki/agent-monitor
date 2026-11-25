import { useCallback, useEffect, useRef, useState } from 'react';
import { getRuns } from './api.js';
import { useLive, useTheme } from './hooks.js';
import { splitRuns } from './lib/format.js';
import { goBack, monitorHref, navigate, useRoute } from './lib/route.js';
import { BackContext } from './BackButton.jsx';
import { AccountsPage } from './accounts/AccountsPage.jsx';
import { WorkflowEditor } from './editor/WorkflowEditor.jsx';
import { StatsPage } from './stats/StatsPage.jsx';
import { Monitor } from './Monitor.jsx';
import { RunView } from './run/RunView.jsx';
import { Sidebar } from './Sidebar.jsx';

export default function App() {
  const route = useRoute();
  const [runs, setRuns] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [updatedAt, setUpdatedAt] = useState(null);
  const [theme, cycleTheme] = useTheme();
  const [tick, setTick] = useState(0);
  const [query, setQuery] = useState('');
  const searchRef = useRef(null);

  const refresh = useCallback(async () => {
    try {
      setRuns(await getRuns());
      setLoadError(null);
      setUpdatedAt(new Date().toISOString());
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);
  const refreshAll = useCallback(() => {
    refresh();
    setTick((t) => t + 1); // the run view, the editor, stats, accounts and the usage tiles refetch on this
  }, [refresh]);

  const connection = useLive(refreshAll);
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Ctrl+K / Cmd+K focuses the search from anywhere.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const { waiting, live, finished } = splitRuns(runs);
  const view = route.view ?? null; // null | 'waiting' | 'active' | 'finished', from the URL
  const current = route.name === 'run' ? 'monitor' : route.name;
  const goMonitor = () => {
    if (route.name !== 'monitor') navigate('#/');
  };
  // Back is hidden on the plain Monitor (no view, no search); on a view or search it returns to the plain Monitor.
  const back =
    route.name === 'monitor' && !view && !query
      ? null
      : () => {
          if (route.name === 'monitor') {
            setQuery('');
            if (view) navigate('#/');
          } else goBack();
        };

  return (
    <div className="shell">
      <Sidebar
        current={current}
        routeName={route.name}
        openCount={waiting.length + live.length}
        counts={{ waiting: waiting.length, active: live.length, finished: finished.length }}
        query={query}
        onQuery={(v) => {
          setQuery(v);
          goMonitor();
        }}
        searchRef={searchRef}
        view={view}
        onView={(v) => {
          navigate(route.name === 'monitor' && view === v ? '#/' : monitorHref(v));
        }}
        connection={connection}
        theme={theme}
        onTheme={cycleTheme}
      />
      <BackContext.Provider value={back}>
        <main className={route.name === 'workflow' ? 'full' : route.name === 'run' ? 'full run-main' : ''}>
          {route.name === 'workflow' && <WorkflowEditor tick={tick} />}
          {route.name === 'stats' && <StatsPage tick={tick} />}
          {route.name === 'accounts' && <AccountsPage tick={tick} />}
          {route.name === 'run' && <RunView key={route.id} id={route.id} tab={route.tab} tick={tick} />}
          {route.name === 'monitor' && (
            <Monitor
              groups={{ waiting, active: live, finished }}
              query={query}
              view={view}
              loadError={loadError}
              updatedAt={updatedAt}
              tick={tick}
              onDone={refreshAll}
            />
          )}
        </main>
      </BackContext.Provider>
    </div>
  );
}
