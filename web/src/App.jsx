import { useCallback, useEffect, useState } from 'react';
import { getRun, getRuns } from './api.js';
import { useLive, useTheme } from './hooks.js';
import { splitRuns } from './lib/format.js';
import { WorkflowEditor } from './editor/WorkflowEditor.jsx';
import { RunDetail } from './RunDetail.jsx';
import { RunsTable } from './RunsTable.jsx';
import { WaitingCards } from './WaitingCards.jsx';

const LIVE_LABEL = { live: 'Live', connecting: 'Connecting', reconnecting: 'Reconnecting' };
const TABS = [
  ['monitor', 'Monitor'],
  ['workflow', 'Workflow'],
];

export default function App() {
  const [tab, setTab] = useState('monitor');
  const [runs, setRuns] = useState([]);
  const [loadError, setLoadError] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [theme, cycleTheme] = useTheme();
  const [tick, setTick] = useState(0);
  const [wfSeen, setWfSeen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setRuns(await getRuns());
      setLoadError(null);
    } catch (e) {
      setLoadError(e.message);
    }
  }, []);

  const refreshDetail = useCallback(async () => {
    if (!selectedId) return;
    try {
      setDetail(await getRun(selectedId));
    } catch {
      /* keep the last good detail */
    }
  }, [selectedId]);

  const refreshAll = useCallback(() => {
    refresh();
    refreshDetail();
    setTick((t) => t + 1);
  }, [refresh, refreshDetail]);

  const connection = useLive(refreshAll);
  useEffect(() => {
    refresh();
  }, [refresh]);
  useEffect(() => {
    setDetail(null);
    refreshDetail();
  }, [refreshDetail]);

  const { waiting, live, finished } = splitRuns(runs);

  return (
    <>
      <header className="app-head">
        <h1>Agent Monitor</h1>
        <nav className="tabs" role="tablist" aria-label="Sections">
          {TABS.map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => {
                setTab(id);
                if (id === 'workflow') setWfSeen(true);
              }}>
              {label}
            </button>
          ))}
        </nav>
        <span className={`conn conn-${connection}`} role="status">
          <span className="dot" aria-hidden="true" /> {LIVE_LABEL[connection]}
        </span>
        <button type="button" onClick={cycleTheme} aria-label={`Theme: ${theme}. Click to change.`}>
          Theme: {theme}
        </button>
      </header>
      <main>
        {wfSeen && (
          <section hidden={tab !== 'workflow'} aria-label="Workflow editor">
            <h2>Workflow</h2>
            <WorkflowEditor tick={tick} />
          </section>
        )}
        {tab === 'monitor' && (
          <>
            {loadError && (
              <p className="error" role="alert">
                Could not load runs: {loadError}
              </p>
            )}
            <WaitingCards runs={waiting} onDone={refreshAll} />
            <section aria-labelledby="runs-h">
              <h2 id="runs-h">Runs ({live.length})</h2>
              <RunsTable runs={live} selectedId={selectedId} onSelect={setSelectedId} caption="Active and waiting runs" />
            </section>
            <details className="finished">
              <summary>Finished runs ({finished.length})</summary>
              <RunsTable runs={finished} selectedId={selectedId} onSelect={setSelectedId} caption="Finished runs" />
            </details>
            {detail && detail.run.id === selectedId ? (
              <RunDetail detail={detail} onChanged={refreshAll} />
            ) : (
              !selectedId && <p className="muted">Select a run to see its map, timeline and agents.</p>
            )}
          </>
        )}
      </main>
    </>
  );
}
