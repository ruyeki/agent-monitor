import { useCallback, useEffect, useState } from 'react';
import { getRuns } from './api.js';
import { useLive, useTheme } from './hooks.js';
import { splitRuns } from './lib/format.js';
import { runHref, useRoute } from './lib/route.js';
import { WorkflowEditor } from './editor/WorkflowEditor.jsx';
import { RunsTable } from './RunsTable.jsx';
import { RunView } from './run/RunView.jsx';
import { WaitingCards } from './WaitingCards.jsx';

const LIVE_LABEL = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting' };
const NAV = [
  ['monitor', '#/', 'Monitor'],
  ['workflow', '#/workflow', 'Workflow'],
];

const openRun = (id) => {
  window.location.hash = runHref(id);
};

function Monitor({ runs, loadError, onChanged }) {
  const { waiting, live, finished } = splitRuns(runs);
  return (
    <>
      {loadError && (
        <p className="error" role="alert">
          Could not load runs: {loadError}
        </p>
      )}
      <WaitingCards runs={waiting} onDone={onChanged} />
      <section aria-labelledby="runs-h">
        <h2 id="runs-h">Runs ({live.length})</h2>
        <RunsTable runs={live} onSelect={openRun} caption="Active and waiting runs" />
      </section>
      <details className="finished">
        <summary>Finished runs ({finished.length})</summary>
        <RunsTable runs={finished} onSelect={openRun} caption="Finished runs" />
      </details>
    </>
  );
}

export default function App() {
  const route = useRoute();
  const [runs, setRuns] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [theme, cycleTheme] = useTheme();
  const [tick, setTick] = useState(0);

  const refresh = useCallback(async () => {
    try {
      setRuns(await getRuns());
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);
  const refreshAll = useCallback(() => {
    refresh();
    setTick((t) => t + 1); // the run view and the editor refetch on this
  }, [refresh]);

  const connection = useLive(refreshAll);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const current = route.name === 'run' ? 'monitor' : route.name;
  return (
    <>
      <header className="app-head">
        <h1>Agent Monitor</h1>
        <nav className="tabs" aria-label="Sections">
          {NAV.map(([id, href, label]) => (
            <a key={id} href={href} className={current === id ? 'active' : ''} aria-current={current === id ? 'page' : undefined}>
              {label}
            </a>
          ))}
        </nav>
        <span className={`conn conn-${connection}`} role="status">
          <span className="dot" aria-hidden="true" /> {LIVE_LABEL[connection]}
        </span>
        <button type="button" onClick={cycleTheme} aria-label={`Theme: ${theme}. Click to change.`}>
          Theme: {theme}
        </button>
      </header>
      <main className={route.name === 'monitor' ? '' : 'full'}>
        {route.name === 'workflow' && <WorkflowEditor tick={tick} />}
        {route.name === 'run' && <RunView key={route.id} id={route.id} tick={tick} />}
        {route.name === 'monitor' && <Monitor runs={runs} loadError={loadError} onChanged={refreshAll} />}
      </main>
    </>
  );
}
