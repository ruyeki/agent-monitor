import { Fragment, useState } from 'react';
import { formatDuration, formatTokens } from '../lib/format.js';

// Per workflow version: finished runs, average tokens and duration; a row expands to per-node figures.
export function VersionStats({ versions }) {
  const [open, setOpen] = useState(() => new Set());
  const toggle = (v) =>
    setOpen((s) => {
      const n = new Set(s);
      if (!n.delete(v)) n.add(v);
      return n;
    });
  return (
    <section aria-label="Workflow versions">
      <h2>Workflow versions</h2>
      {versions.length === 0 ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Finished runs</th>
              <th>Avg tokens per run</th>
              <th>Avg duration</th>
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => {
              const isOpen = open.has(v.version);
              return (
                <Fragment key={v.version}>
                  <tr>
                    <td>
                      <button type="button" aria-expanded={isOpen} aria-label={`${isOpen ? 'Hide' : 'Show'} nodes of v${v.version}`} onClick={() => toggle(v.version)}>
                        {isOpen ? '▾' : '▸'} v{v.version}
                      </button>
                    </td>
                    <td>{v.finishedRuns}</td>
                    <td>{v.finishedRuns ? formatTokens(v.avgTokens) : '-'}</td>
                    <td>{v.finishedRuns ? formatDuration(v.avgDurationMs) : '-'}</td>
                  </tr>
                  {isOpen &&
                    (v.nodes || []).map((n) => (
                      <tr key={n.id} className="node-row" data-node-row={n.id}>
                        <td>{n.name || n.id}</td>
                        <td>{n.runs}</td>
                        <td>{formatTokens(n.avgTokens)}</td>
                        <td>{formatDuration(n.avgDurationMs)}</td>
                      </tr>
                    ))}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </section>
  );
}
