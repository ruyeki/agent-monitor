import { useEffect, useState } from 'react';
import { getRun } from '../api.js';
import { StatusBadge } from '../RunsTable.jsx';
import { RunGraph } from './RunGraph.jsx';
import { RunSide } from './RunSide.jsx';

// #/runs/<id>: the run's pinned graph plus a side panel. `tick` changes on every live (SSE) event.
export function RunView({ id, tick = 0 }) {
  const [detail, setDetail] = useState(null);
  const [error, setError] = useState(null);
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let stale = false;
    getRun(id).then(
      (d) => !stale && (setDetail(d), setError(null)),
      (e) => !stale && setError(e.message), // keep the last good detail on screen
    );
    return () => {
      stale = true;
    };
  }, [id, tick, reload]);

  if (!detail) {
    return error ? (
      <p className="error pad" role="alert">
        Could not load run {id}: {error}
      </p>
    ) : (
      <p className="muted pad">Loading run…</p>
    );
  }
  const { run } = detail;
  return (
    <section className="run-view" aria-label={`Run ${run.id}`}>
      <header className="run-head">
        <a href="#/">Back to monitor</a>
        <h2>{run.title}</h2>
        <span className="muted mono">{run.id}</span> <StatusBadge status={run.status} />
        {run.repo && (
          <span className="muted">
            {' '}
            · {run.repo}
            {run.branch ? ` @ ${run.branch}` : ''}
          </span>
        )}
        {error && (
          <span className="error" role="alert">
            {' '}
            Out of date: {error}
          </span>
        )}
      </header>
      <div className="run-body">
        <RunGraph detail={detail} />
        <RunSide detail={detail} onChanged={() => setReload((n) => n + 1)} />
      </div>
    </section>
  );
}
