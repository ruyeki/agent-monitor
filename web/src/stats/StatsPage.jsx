import { useEffect, useState } from 'react';
import { getPrices, getUsageStats, getVersionStats } from '../api.js';
import { DailyChart } from './DailyChart.jsx';
import { PeriodCards } from './PeriodCards.jsx';
import { PriceTable } from './PriceTable.jsx';
import { VersionStats } from './VersionStats.jsx';

// Fetches one resource; keeps the last good value on a failed refresh. `tick` changes on every live event.
function useFetched(load, deps) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    let stale = false;
    load().then(
      (d) => !stale && (setData(d), setError(null)),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [data, error];
}

export function StatsPage({ tick = 0 }) {
  const [days, setDays] = useState(90);
  const [usage, usageError] = useFetched(() => getUsageStats(days), [days, tick]);
  const [versions, versionsError] = useFetched(getVersionStats, [tick]);
  const [prices, setPrices] = useState(null);
  const [pricesError, setPricesError] = useState(null);
  useEffect(() => {
    getPrices().then(setPrices, (e) => setPricesError(e.message));
  }, []);

  const st = usage?.indexer;
  return (
    <section className="stats-page" aria-label="Usage statistics">
      <h2>Usage</h2>
      {[usageError, versionsError, pricesError].filter(Boolean).map((m) => (
        <p key={m} className="error" role="alert">
          Could not load stats: {m}
        </p>
      ))}
      {!usage && !usageError && <p className="muted">Loading usage…</p>}
      {usage && (
        <>
          <PeriodCards periods={usage.periods} />
          {usage.unpricedModels?.length > 0 && (
            <p className="muted" role="note">
              No price for {usage.unpricedModels.join(', ')}: their cost counts as $0.
            </p>
          )}
          <DailyChart daily={usage.daily} days={days} onDays={setDays} />
          <p className="muted" aria-label="Indexer status">
            {st
              ? `Indexer: ${st.messages} messages from ${st.files} files · ${st.scanning ? 'scanning now' : st.lastScanAt ? `last scan ${new Date(st.lastScanAt).toLocaleTimeString()}` : 'not scanned yet'}`
              : 'Indexer: no status'}
          </p>
        </>
      )}
      {versions && <VersionStats versions={versions} />}
      {prices && <PriceTable prices={prices} onSaved={setPrices} />}
    </section>
  );
}
