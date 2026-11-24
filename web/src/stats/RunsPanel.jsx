import { useMemo } from 'react';
import { formatDuration } from '../lib/format.js';
import { dayLabel, niceTicks, summarizeRuns } from './chart.js';
import { LineMarks } from './LineMarks.jsx';
import { useIntro } from './useIntro.js';
import { useRovingHits } from './useRovingHits.js';
import { useWidth } from './useWidth.js';

const H = 150;
const M = { l: 30, r: 6, t: 8, b: 22 };
const PLOT_H = H - M.t - M.b;
const OUTCOMES = [
  ['finished', 'Done', 'var(--ok)'],
  ['stopped', 'Stopped', 'var(--run-idle)'], // a stop the user asked for is not a failure
  ['open', 'Running or waiting', 'var(--run-run)'],
];

const runsLabel = (d) => `${dayLabel(d.day)} · ${d.count} ${d.count === 1 ? 'run' : 'runs'}`;

// Runs started per day over the shown range, how they ended, and the typical finished run.
export function RunsPanel({ runs, range }) {
  const s = useMemo(() => summarizeRuns(runs, range), [runs, range]);
  const intro = useIntro();
  const [wrapRef, W] = useWidth(520, 200, 640);
  const ticks = niceTicks(Math.max(0, ...s.perDay.map((d) => d.count)), { integer: true });
  const max = ticks[ticks.length - 1];
  const plotW = W - M.l - M.r;
  const step = plotW / s.perDay.length;
  const y = (v) => M.t + PLOT_H - (v / max) * PLOT_H;
  const every = Math.ceil(s.perDay.length / Math.max(2, Math.floor(plotW / 64)));
  const { hitsRef, hoverIdx, hitProps, clearHover, tooltipStyle } = useRovingHits(s.perDay.map((d) => d.day));
  const hovered = s.perDay[hoverIdx];

  return (
    <section className="panel" aria-label="Runs">
      <h2>Runs</h2>
      <div className="runs-body">
        <div className="runs-chart" ref={wrapRef} onMouseLeave={clearHover}>
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Runs started per day over the last ${range} days, ${s.total} in total`}>
            {ticks.map((t) => (
              <g key={t}>
                <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="grid" />
                <text x={M.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
                  {t}
                </text>
              </g>
            ))}
            {s.perDay.map((d, i) =>
              i % every === 0 ? (
                <text key={d.day} x={M.l + (i + 0.5) * step} y={H - 6} textAnchor="middle" className="axis">
                  {dayLabel(d.day)}
                </text>
              ) : null,
            )}
            <LineMarks lines={[{ key: 'runs', color: 'var(--series-1)', values: s.perDay.map((d) => d.count) }]} plot={{ left: M.l, step, top: M.t, height: PLOT_H, max }} hoverIdx={hoverIdx} dotAlways intro={intro} />
            <g ref={hitsRef}>
              {s.perDay.map((d, i) => (
                <rect key={d.day} data-run-hit={d.day} x={M.l + i * step} y={M.t} width={step} height={PLOT_H} fill="transparent" aria-label={runsLabel(d)} {...hitProps(i)} />
              ))}
            </g>
          </svg>
          {hovered && (
            <div className="tooltip" role="status" style={tooltipStyle}>
              {runsLabel(hovered)}
            </div>
          )}
        </div>
        <div className="runs-figures">
          <div className="outcomes">
            {OUTCOMES.map(([key, label, color]) => (
              <div key={key} className="outcome" data-outcome={key}>
                <span className="dot" style={{ background: color }} aria-hidden="true" />
                <span className="outcome-label">{label}</span>
                <span className="outcome-count">{s.outcomes[key]}</span>
              </div>
            ))}
          </div>
          <div className="figure">
            <div className="figure-label">Median duration</div>
            <div className="figure-value">{s.medianMs === null ? '-' : formatDuration(s.medianMs)}</div>
          </div>
          <div className="figure">
            <div className="figure-label">Avg fix rounds</div>
            <div className="figure-value">{s.avgRounds === null ? '-' : s.avgRounds.toFixed(1)}</div>
          </div>
        </div>
      </div>
      <div className="sr-only">
        <table aria-label="Runs per day table">
          <thead>
            <tr>
              <th>Day</th>
              <th>Runs</th>
            </tr>
          </thead>
          <tbody>
            {s.perDay.filter((d) => d.count > 0).map((d) => (
              <tr key={d.day}>
                <td>{d.day}</td>
                <td>{d.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
