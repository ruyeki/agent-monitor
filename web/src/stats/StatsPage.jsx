import { useEffect, useMemo, useState } from 'react';
import { getPrices, getRuns, getUsageStats, getVersionStats } from '../api.js';
import { useThrottledTick } from '../hooks.js';
import { DailyChart } from './DailyChart.jsx';
import { KpiStrip } from './KpiStrip.jsx';
import { PriceTable } from './PriceTable.jsx';
import { RunsPanel } from './RunsPanel.jsx';
import { SpendByModel } from './SpendByModel.jsx';
import { StageStats } from './StageStats.jsx';
import { Toggle, useStoredChoice } from './Toggle.jsx';
import { dayRange, modelSlots } from './chart.js';

const RANGES = ['7', '30', '90'];
const METRICS = ['cost', 'tokens'];

// Fetches one resource; keeps the last good value on a failed refresh. `key` says which request the value answers.
function useFetched(load, deps, key) {
  const [state, setState] = useState({ data: null, key: null });
  const [error, setError] = useState(null);
  useEffect(() => {
    let stale = false;
    load().then(
      (d) => !stale && (setState({ data: d, key }), setError(null)),
      (e) => !stale && setError(e.message),
    );
    return () => {
      stale = true;
    };
  }, deps); // eslint-disable-line react-hooks/exhaustive-deps
  return [state.data, error, state.key];
}

// `tick` changes on every live event; the page re-reads at most every 30 s.
export function StatsPage({ tick = 0 }) {
  const [rangeText, setRange] = useStoredChoice('agent-monitor-stats-range', RANGES, '30');
  const [metric, setMetric] = useStoredChoice('agent-monitor-stats-metric', METRICS, 'cost');
  const range = Number(rangeText);
  const live = useThrottledTick(tick);
  const [reload, setReload] = useState(0); // bumped by a saved price change: costs are stale at once
  const [usage, usageError, usageFor] = useFetched(() => getUsageStats(range * 2), [range, live, reload], range);
  const [versions, versionsError] = useFetched(getVersionStats, [live, reload]);
  const [runs, runsError] = useFetched(getRuns, [live]);
  const [prices, setPrices] = useState(null);
  const [pricesError, setPricesError] = useState(null);
  useEffect(() => {
    getPrices().then(setPrices, (e) => setPricesError(e.message));
  }, []);

  const daily = useMemo(() => (usage?.daily ?? []).filter((r) => r.provider !== 'codex'), [usage]);
  const slots = useMemo(() => modelSlots(daily), [daily]);
  const shownRows = useMemo(() => {
    const shown = new Set(dayRange(range));
    return daily.filter((r) => shown.has(r.day));
  }, [daily, range]);

  const st = usage?.indexer;
  return (
    <>
      <header className="page-head">
        <h1>Stats</h1>
        <Toggle label="Range" value={rangeText} onChange={setRange} options={[['7', '7 days'], ['30', '30 days'], ['90', '90 days']]} />
        <Toggle label="Metric" value={metric} onChange={setMetric} options={[['cost', 'Cost'], ['tokens', 'Tokens']]} />
      </header>
      {usage && <KpiStrip periods={usage.periods} codex={usage.codex} metric={metric} />}
      <section className="stats-page" aria-label="Usage statistics">
        <p className="muted costs-note">Costs are API-equivalent estimates, not billing.</p>
        {[usageError, versionsError, runsError, pricesError].filter(Boolean).map((m) => (
          <p key={m} className="error" role="alert">
            Could not load stats: {m}
          </p>
        ))}
        {!usage && !usageError && <p className="muted">Loading usage…</p>}
        {usage && (
          <>
            {usage.unpricedModels?.length > 0 && (
              <p className="muted" role="note">
                No price for {usage.unpricedModels.join(', ')}: their cost counts as $0.
              </p>
            )}
            <DailyChart daily={daily} range={range} metric={metric} slots={slots} firstDay={usage.firstDay} ready={usageFor === range} />
            <SpendByModel rows={shownRows} metric={metric} slots={slots} range={range} />
          </>
        )}
        {versions && <StageStats versions={versions} metric={metric} />}
        {runs && <RunsPanel runs={runs} range={range} />}
        {usage && (
          <p className="muted" aria-label="Indexer status">
            {st
              ? `Indexer: ${st.messages} messages from ${st.files} files · ${st.scanning ? 'scanning now' : st.lastScanAt ? `last scan ${new Date(st.lastScanAt).toLocaleTimeString()}` : 'not scanned yet'}`
              : 'Indexer: no status'}
          </p>
        )}
        {prices && <PriceTable prices={prices} onSaved={(p) => {
          setPrices(p);
          setReload((n) => n + 1);
        }} />}
      </section>
    </>
  );
}
