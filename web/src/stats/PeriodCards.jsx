import { formatCost, formatTokens } from '../lib/format.js';

const CARDS = [
  ['today', 'Today'],
  ['week', 'This week'],
  ['month', 'This month'],
  ['avg30', 'Daily average (last 30 days with data)'],
];

// Total tokens are the headline; the dollar figure is a secondary, labelled estimate.
export function PeriodCards({ periods }) {
  return (
    <div className="period-cards">
      {CARDS.map(([key, label]) => {
        const t = periods?.[key] || {};
        return (
          <article key={key} className="period-card" aria-label={label}>
            <h3>{label}</h3>
            <p className="big">{formatTokens(t.total)}</p>
            <p className="muted">tokens</p>
            <dl className="breakdown">
              <dt>Input</dt>
              <dd>{formatTokens(t.input)}</dd>
              <dt>Output</dt>
              <dd>{formatTokens(t.output)}</dd>
              <dt>Cache write</dt>
              <dd>{formatTokens(t.cacheWrite)}</dd>
              <dt>Cache read</dt>
              <dd>{formatTokens(t.cacheRead)}</dd>
            </dl>
            <p className="muted">≈ {formatCost(t.cost)} API-equivalent (estimate)</p>
          </article>
        );
      })}
    </div>
  );
}
