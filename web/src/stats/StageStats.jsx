import { useState } from 'react';
import { formatCost, formatDuration, formatTokens } from '../lib/format.js';

// Where a finished run's tokens go, per workflow stage, for one published version (newest with finished runs by default).
export function StageStats({ versions, metric }) {
  const [picked, setPicked] = useState(null);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const fallback = sorted.find((v) => v.finishedRuns > 0) ?? sorted[0];
  const version = sorted.find((v) => v.version === picked) ?? fallback;
  const key = metric === 'cost' ? 'avgCost' : 'avgTokens';
  const stages = (version?.nodes || []).filter((n) => n.runs > 0 && (n.avgTokens > 0 || n.avgDurationMs > 0));
  const top = Math.max(0, ...stages.map((n) => n[key] || 0));

  return (
    <section className="panel" aria-label="Where a run's tokens go">
      <div className="panel-head">
        <h2>Where a run&apos;s tokens go</h2>
        {sorted.length > 1 && (
          <div role="group" aria-label="Version" className="toggle">
            {sorted.map((v) => (
              <button key={v.version} type="button" aria-pressed={v.version === version.version} className={v.version === version.version ? 'on' : ''} onClick={() => setPicked(v.version)}>
                v{v.version}
              </button>
            ))}
          </div>
        )}
      </div>
      {!version ? (
        <p className="muted">No published versions yet.</p>
      ) : (
        <>
          {version.finishedRuns === 0 ? (
            <p className="muted">No finished runs on v{version.version} yet.</p>
          ) : (
            <>
              <p className="muted stage-summary">
                {version.finishedRuns} finished {version.finishedRuns === 1 ? 'run' : 'runs'} · avg {formatTokens(version.avgTokens)} tokens · ≈ {formatCost(version.avgCost)} · {formatDuration(version.avgDurationMs)} per run
              </p>
              <ol className="bar-list stage-list" aria-label="Stages">
                {stages.map((n) => (
                  <li key={n.id} data-stage={n.id} className="bar-row stage-row">
                    <span className="bar-label">{n.name || n.id}</span>
                    <span className="bar-track" aria-hidden="true">
                      <span className="bar-fill" style={{ width: `${top ? ((n[key] || 0) / top) * 100 : 0}%`, background: 'var(--series-1)' }} />
                    </span>
                    <span className="bar-value">{metric === 'cost' ? `≈ ${formatCost(n.avgCost)}` : `${formatTokens(n.avgTokens)} tokens`}</span>
                    <span className="bar-share">{metric === 'cost' ? `${formatTokens(n.avgTokens)} tokens` : `≈ ${formatCost(n.avgCost)}`}</span>
                    <span className="bar-other muted">
                      {formatDuration(n.avgDurationMs)}
                      {n.runs < version.finishedRuns && ` · ${n.runs} of ${version.finishedRuns} runs`}
                    </span>
                  </li>
                ))}
              </ol>
            </>
          )}
          <div className="table-scroll">
            <table aria-label="Workflow versions">
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Finished runs</th>
                  <th>Avg tokens</th>
                  <th>Avg cost</th>
                  <th>Avg duration</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((v) => (
                  <tr key={v.version}>
                    <td>v{v.version}</td>
                    <td>{v.finishedRuns}</td>
                    <td>{v.finishedRuns ? formatTokens(v.avgTokens) : '-'}</td>
                    <td>{v.finishedRuns ? formatCost(v.avgCost) : '-'}</td>
                    <td>{v.finishedRuns ? formatDuration(v.avgDurationMs) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
