import { formatCost, formatTokens } from '../lib/format.js';
import { rankByMetric, seriesColor, shareLabel, totalsByModel } from './chart.js';

// Models ranked by the selected metric over the shown range. The bar is decoration; the text carries the numbers.
export function SpendByModel({ rows, metric, slots }) {
  const ranked = rankByMetric(totalsByModel(rows), metric);
  const key = metric === 'cost' ? 'cost' : 'tokens';
  const top = ranked[0]?.[key] || 0;
  const total = ranked.reduce((n, t) => n + t[key], 0);
  return (
    <section className="panel" aria-label="Spend by model">
      <h2>Spend by model</h2>
      {ranked.length === 0 ? (
        <p className="muted">No usage in this range.</p>
      ) : (
        <ol className="bar-list" aria-label={`Models ranked by ${metric}`}>
          {ranked.map((t) => (
            <li key={t.label} data-model={t.label} className="bar-row">
              <span className="bar-label">{t.label}</span>
              <span className="bar-track" aria-hidden="true">
                <span className="bar-fill" style={{ width: `${top ? (t[key] / top) * 100 : 0}%`, background: seriesColor(slots.get(t.label)) }} />
              </span>
              <span className="bar-value">{metric === 'cost' ? formatCost(t.cost) : formatTokens(t.tokens)}</span>
              <span className="bar-share">{shareLabel(total ? (t[key] / total) * 100 : 0)}</span>
              <span className="bar-other muted">{metric === 'cost' ? `${formatTokens(t.tokens)} tokens` : `≈ ${formatCost(t.cost)}`}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
