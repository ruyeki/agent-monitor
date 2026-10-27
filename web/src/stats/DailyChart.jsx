import { useMemo, useState } from 'react';
import { formatTokens } from '../lib/format.js';
import { buildSeries, dayLabel, niceMax } from './chart.js';

const W = 900;
const H = 260;
const M = { l: 48, r: 8, t: 10, b: 24 };
const PLOT_W = W - M.l - M.r;
const PLOT_H = H - M.t - M.b;
const colorOf = (s) => (s.slot < 0 ? 'var(--series-other)' : `var(--series-${s.slot + 1})`);

function Toggle({ label, value, options, onChange }) {
  return (
    <div role="group" aria-label={label} className="toggle">
      {options.map(([v, text]) => (
        <button key={v} type="button" aria-pressed={value === v} className={value === v ? 'on' : ''} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  );
}

// Daily stacked bars, hand-rolled SVG. A visually hidden table is the text alternative.
export function DailyChart({ daily, days, onDays }) {
  const [mode, setMode] = useState('model');
  const [hover, setHover] = useState(null);
  const { series, columns } = useMemo(() => buildSeries(daily || [], mode, days), [daily, mode, days]);
  const max = niceMax(Math.max(0, ...columns.map((c) => c.total)));
  const step = PLOT_W / columns.length;
  const y = (v) => M.t + PLOT_H - (v / max) * PLOT_H;
  const every = Math.ceil(columns.length / 8);
  const hoverIdx = columns.findIndex((c) => c.day === hover);
  const hovered = columns[hoverIdx];
  const grand = columns.reduce((n, c) => n + c.total, 0);

  return (
    <section className="daily-chart" aria-label="Daily tokens">
      <div className="chart-head">
        <h2>Daily tokens</h2>
        <Toggle label="Period" value={days} onChange={onDays} options={[[30, '30 days'], [90, '90 days']]} />
        <Toggle label="Split" value={mode} onChange={setMode} options={[['model', 'By model'], ['type', 'By token type']]} />
      </div>
      <ul className="legend" aria-label="Legend">
        {series.map((s) => (
          <li key={s.key}>
            <span className="swatch" style={{ background: colorOf(s) }} aria-hidden="true" /> {s.label}
          </li>
        ))}
      </ul>
      <div className="chart-wrap" onMouseLeave={() => setHover(null)}>
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`Stacked bars of daily tokens over the last ${days} days, ${formatTokens(grand)} in total. The table below has the numbers.`}>
          {[0, 0.5, 1].map((f) => (
            <g key={f}>
              <line x1={M.l} x2={W - M.r} y1={y(max * f)} y2={y(max * f)} className="grid" />
              <text x={M.l - 6} y={y(max * f) + 4} textAnchor="end" className="axis">
                {formatTokens(max * f)}
              </text>
            </g>
          ))}
          {columns.map((c, i) => {
            const x = M.l + i * step;
            let acc = 0;
            return (
              <g key={c.day}>
                {series.map((s) => {
                  const v = c.values[s.key];
                  if (!v) return null;
                  const top = y(acc + v);
                  const h = y(acc) - top;
                  acc += v;
                  return <rect key={s.key} data-day={c.day} data-series={s.key} x={x + 1} y={top} width={Math.max(1, step - 2)} height={h} rx="2" fill={colorOf(s)} stroke="var(--surface)" strokeWidth="2" />;
                })}
                {i % every === 0 && (
                  <text x={x + step / 2} y={H - 6} textAnchor="middle" className="axis">
                    {dayLabel(c.day)}
                  </text>
                )}
                <rect
                  data-hit={c.day}
                  x={x}
                  y={M.t}
                  width={step}
                  height={PLOT_H}
                  fill="transparent"
                  tabIndex={0}
                  aria-label={`${dayLabel(c.day)}: ${formatTokens(c.total)} tokens`}
                  onMouseEnter={() => setHover(c.day)}
                  onFocus={() => setHover(c.day)}
                  onBlur={() => setHover(null)}
                />
              </g>
            );
          })}
        </svg>
        {hovered && (
          <div className="tooltip" role="status" style={{ left: `${Math.min(75, Math.max(0, ((hoverIdx + 0.5) / columns.length) * 100 - 10))}%` }}>
            <strong>{dayLabel(hovered.day)}</strong> · {formatTokens(hovered.total)} tokens
            {series.filter((s) => hovered.values[s.key]).map((s) => (
              <div key={s.key}>
                <span className="swatch" style={{ background: colorOf(s) }} aria-hidden="true" /> {s.label}: {formatTokens(hovered.values[s.key])}
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="sr-only">
      <table aria-label="Daily tokens table">
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
                <td key={s.key}>{c.values[s.key]}</td>
              ))}
              <td>{c.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
    </section>
  );
}
