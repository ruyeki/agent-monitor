import { linePath, linePoints } from './chart.js';

// The marks of a per-day line chart: one 2px line per series, and for the hovered day a guide line plus a dot per line.
// `lines` = [{ key, color, values }] in draw order (last is on top); `plot` = { left, step, top, height, max }.
// A line only gets a dot on the hovered day when it has a value then, unless `dotAlways`.
export function LineMarks({ lines, plot, hoverIdx, dotAlways = false }) {
  const drawn = lines.map((l) => ({ ...l, points: linePoints(l.values, plot) }));
  const at = hoverIdx >= 0 ? drawn[0]?.points[hoverIdx] : null;
  return (
    <g pointerEvents="none">
      {drawn.map((l) => (
        <path key={l.key} className="series-line" data-series={l.key} d={linePath(l.points)} fill="none" stroke={l.color} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {at && <line className="guide" x1={at.x} x2={at.x} y1={plot.top} y2={plot.top + plot.height} stroke="var(--border-strong)" strokeWidth="1" />}
      {at &&
        drawn
          .filter((l) => dotAlways || l.values[hoverIdx] > 0)
          .map((l) => <circle key={l.key} className="dot" data-dot={l.key} cx={l.points[hoverIdx].x} cy={l.points[hoverIdx].y} r="4" fill={l.color} stroke="var(--surface)" strokeWidth="2" />)}
    </g>
  );
}
