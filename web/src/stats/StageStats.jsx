import { useState } from 'react';
import { formatCost, formatDuration, formatTokens } from '../lib/format.js';
import { shareLabel, stageSlices } from './chart.js';
import { Donut } from './Donut.jsx';
import { useIntro } from './useIntro.js';

// Where a finished run's tokens go, per workflow stage, for one published version (newest with finished runs by default).
export function StageStats({ versions, metric }) {
  const [picked, setPicked] = useState(null);
  const intro = useIntro();
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const fallback = sorted.find((v) => v.finishedRuns > 0) ?? sorted[0];
  const version = sorted.find((v) => v.version === picked) ?? fallback;
  const fmt = (v) => (metric === 'cost' ? formatCost(v) : `${formatTokens(v)} tokens`);
  const { total, slices } = version?.finishedRuns > 0 ? stageSlices(version, metric) : { total: 0, slices: [] };
  const donutSlices = slices.map((s) => ({
    key: s.key,
    label: s.label,
    value: s.value,
    valueText: fmt(s.value),
    color: s.color,
    row: (
      <>
        <span className="legend-label">{s.label}</span>
        <span className="legend-value">{fmt(s.value)}</span>
        <span className="legend-share">{shareLabel(total ? (s.value / total) * 100 : 0)}</span>
        <span className="legend-other muted">
          {s.node ? formatDuration(s.node.avgDurationMs) : '-'}
          {s.node && s.node.runs < version.finishedRuns && ` · ${s.node.runs} of ${version.finishedRuns} runs`}
        </span>
      </>
    ),
  }));

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
              <Donut
                title="Where a run's tokens go"
                totalText={fmt(total)}
                slices={donutSlices}
                total={total}
                centre={{ value: fmt(total), label: 'per run' }}
                legendLabel="Stages"
                attr="data-stage"
                intro={intro}
              />
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
