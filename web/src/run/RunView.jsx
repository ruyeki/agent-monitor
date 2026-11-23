import { useEffect, useState } from 'react';
import { getRun } from '../api.js';
import { RunGraph } from './RunGraph.jsx';
import { RunHeader } from './RunHeader.jsx';
import { RunSide } from './RunSide.jsx';

// #/runs/<id>[/<tab>]: the shared run header and tabs, then the tab. Stages (the only tab so far) is the pinned graph
// plus a side panel. `tick` changes on every live (SSE) event.
export function RunView({ id, tab = 'stages', tick = 0 }) {
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
      <p className="error" role="alert">
        Could not load run {id}: {error}
      </p>
    ) : (
      <p className="muted">Loading run…</p>
    );
  }
  const { run } = detail;
  const changed = () => setReload((n) => n + 1);
  return (
    <section className="run-view" aria-label={`Run ${run.id}`}>
      <RunHeader detail={detail} tab="stages" error={error} onChanged={changed} />
      {/* Only the Stages tab exists so far: a crew or ledger link (tab) shows it too until those tabs land. */}
      <div className="run-body" role="tabpanel" id="panel-stages" aria-labelledby="tab-stages">
        <RunGraph detail={detail} />
        <RunSide detail={detail} onChanged={changed} />
      </div>
    </section>
  );
}
