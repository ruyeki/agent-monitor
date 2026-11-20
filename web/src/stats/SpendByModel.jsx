import { formatCost, formatTokens } from '../lib/format.js';
import { seriesColor, shareLabel, topModels } from './chart.js';
import { Donut } from './Donut.jsx';

// Models by the selected metric over the shown range, as a donut with a legend that carries the numbers.
// Same models and colours as the daily chart (topModels).
export function SpendByModel({ rows, metric, slots, range }) {
  const models = topModels(rows, metric, slots);
  const key = metric === 'cost' ? 'cost' : 'tokens';
  const total = models.reduce((n, t) => n + t[key], 0);
  const fmt = (v) => (metric === 'cost' ? formatCost(v) : formatTokens(v));
  const slices = models.map((t) => ({
    key: t.key,
    label: t.label,
    value: t[key],
    valueText: fmt(t[key]),
    color: seriesColor(t.slot),
    row: (
      <>
        <span className="legend-label">{t.key === 'Other' ? `Other (${t.count} models)` : t.label}</span>
        <span className="legend-value">{fmt(t[key])}</span>
        <span className="legend-share">{shareLabel(total ? (t[key] / total) * 100 : 0)}</span>
        <span className="legend-other muted">{metric === 'cost' ? `${formatTokens(t.tokens)} tokens` : `≈ ${formatCost(t.cost)}`}</span>
      </>
    ),
  }));
  return (
    <section className="panel" aria-label="Spend by model">
      <h2>Spend by model</h2>
      {models.length === 0 ? (
        <p className="muted">No usage in this range.</p>
      ) : (
        <Donut
          title="Spend by model"
          totalText={`${fmt(total)}${metric === 'cost' ? '' : ' tokens'}`}
          slices={slices}
          total={total}
          centre={{ value: `${fmt(total)}${metric === 'cost' ? '' : ' tokens'}`, label: `in ${range} days` }}
          legendLabel={`Models ranked by ${metric}`}
          attr="data-model"
        />
      )}
    </section>
  );
}
