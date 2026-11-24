import { useMemo, useState } from 'react';
import { formatCost, formatTokens } from '../lib/format.js';
import { buildSeries, compactCost, dayLabel, maxSeriesValue, niceTicks, periodDelta, seriesColor, shareLabel } from './chart.js';
import { LineMarks } from './LineMarks.jsx';
import { Toggle } from './Toggle.jsx';
import { useIntro } from './useIntro.js';
import { useRovingHits } from './useRovingHits.js';
import { useWidth } from './useWidth.js';

const H = 240;
const M = { l: 46, r: 8, t: 10, b: 24 };
const PLOT_H = H - M.t - M.b;

// Daily lines (one per series, not stacked), hand-rolled SVG. A visually hidden table is the text alternative.
// `daily` covers 2 x `range` days (non-Codex rows); the earlier half only feeds the comparison.
export function DailyChart({ daily, range, metric, slots, firstDay, ready = true }) {
  const [split, setSplit] = useState('model');
  const intro = useIntro();
  const [wrapRef, W] = useWidth();
  const fmt = metric === 'cost' ? formatCost : formatTokens;
  const noun = metric === 'cost' ? 'cost' : 'tokens';
  const { series, columns, total } = useMemo(() => buildSeries(daily || [], { split, metric, days: range, slots }), [daily, split, metric, range, slots]);
  const delta = useMemo(() => periodDelta(daily || [], { metric, range, firstDay }), [daily, metric, range, firstDay]);
  const ticks = niceTicks(maxSeriesValue(columns));
  const max = ticks[ticks.length - 1];
  const tickLabel = metric === 'cost' ? compactCost : formatTokens;
  const plotW = W - M.l - M.r;
  const step = plotW / columns.length;
  const y = (v) => M.t + PLOT_H - (v / max) * PLOT_H;
  const every = Math.ceil(columns.length / Math.max(2, Math.floor(plotW / 64)));
  const { hitsRef, hoverIdx, hitProps, clearHover, tooltipStyle } = useRovingHits(columns.map((c) => c.day));
  const hovered = columns[hoverIdx];

  return (
    <section className="panel daily-chart" aria-label={`Daily ${noun}`}>
      <div className="chart-head">
        <h2>{`Daily ${noun}`}</h2>
        <span className="range-total">{`${fmt(total)}${metric === 'cost' ? '' : ' tokens'} in ${range} days`}</span>
        {ready && (
          <span className={`delta delta-${delta.kind}`} aria-label="Change vs previous period">
            {delta.text}
          </span>
        )}
        <Toggle label="Split" value={split} onChange={setSplit} options={[['model', 'By model'], ['type', 'By token type']]} />
      </div>
      <ul className="legend" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: seriesColor(s.slot) }} aria-hidden="true" />
            {s.label}
          </li>
        ))}
      </ul>
      <div className="chart-wrap" ref={wrapRef} onMouseLeave={clearHover}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Lines of daily ${noun} over the last ${range} days, ${fmt(total)} in total. The table below has the numbers.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={M.l} x2={W - M.r} y1={y(t)} y2={y(t)} className="grid" />
              <text x={M.l - 6} y={y(t) + 4} textAnchor="end" className="axis">
                {tickLabel(t)}
              </text>
            </g>
          ))}
          {columns.map((c, i) =>
            i % every === 0 ? (
              <text key={c.day} x={M.l + (i + 0.5) * step} y={H - 6} textAnchor="middle" className="axis">
                {dayLabel(c.day)}
              </text>
            ) : null,
          )}
          <LineMarks
            lines={[...series].reverse().map((s) => ({ key: s.key, color: seriesColor(s.slot), values: columns.map((c) => c.values[s.key]) }))}
            plot={{ left: M.l, step, top: M.t, height: PLOT_H, max }}
            hoverIdx={hoverIdx}
            intro={intro}
          />
          <g ref={hitsRef}>
            {columns.map((c, i) => (
              <rect
                key={c.day}
                data-hit={c.day}
                x={M.l + i * step}
                y={M.t}
                width={step}
                height={PLOT_H}
                fill="transparent"
                aria-label={`${dayLabel(c.day)}: ${fmt(c.total)}${metric === 'cost' ? '' : ' tokens'}`}
                {...hitProps(i)}
              />
            ))}
          </g>
        </svg>
        {hovered && (
          <div className="tooltip" role="status" style={tooltipStyle}>
            <strong>{dayLabel(hovered.day)}</strong> · {fmt(hovered.total)}
            {metric === 'cost' ? '' : ' tokens'}
            {series.filter((s) => hovered.values[s.key] > 0).sort((a, b) => hovered.values[b.key] - hovered.values[a.key]).map((s) => (
              <div key={s.key}>
                <span className="swatch" style={{ background: seriesColor(s.slot) }} aria-hidden="true" /> {s.label}: {fmt(hovered.values[s.key])} ({shareLabel((hovered.values[s.key] / hovered.total) * 100)})
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sr-only">
        <table aria-label={`Daily ${noun} table`}>
          <thead>
            <tr>
              <th>Day</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {columns.filter((c) => c.total > 0).map((c) => (
              <tr key={c.day}>
                <td>{c.day}</td>
                {series.map((s) => (
                  <td key={s.key}>{metric === 'cost' ? formatCost(c.values[s.key] ?? 0) : c.values[s.key]}</td>
                ))}
                <td>{metric === 'cost' ? formatCost(c.total) : c.total}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
