import { formatCost, formatTokens } from '../lib/format.js';

const TILES = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['avg30', 'Daily average (30 d)'],
];

// Four tiles in Monitor's stat strip: the selected metric is the figure, the other one sits under it.
export function KpiStrip({ periods, codex, metric }) {
  return (
    <section className="stat-strip" aria-label="Usage summary">
      {TILES.map(([key, label]) => {
        const t = periods?.[key] || {};
        const cx = codex?.[key];
        return (
          <div key={key} className="stat" role="group" aria-label={label}>
            <div className="stat-label">{label}</div>
            <div className="stat-value">{metric === 'cost' ? formatCost(t.cost) : formatTokens(t.total)}</div>
            <div className="stat-sub">{metric === 'cost' ? `${formatTokens(t.total)} tokens` : `≈ ${formatCost(t.cost)}`}</div>
            {cx?.total > 0 && (
              <div className="codex-line stat-sub" aria-label={`Codex ${label}`}>
                Codex: {formatTokens(cx.total)} tokens
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}
