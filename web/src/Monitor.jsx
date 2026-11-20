import { useEffect, useState } from 'react';
import { getUsageStats } from './api.js';
import { useThrottledTick } from './hooks.js';
import { Ago } from './Ago.jsx';
import { formatCost, formatTokens } from './lib/format.js';
import { runHref } from './lib/route.js';
import { RunList, StatusIcon, stageLabel } from './RunList.jsx';
import { WaitingCard } from './WaitingCards.jsx';

const GROUPS = [
  ['waiting', 'Waiting on you', 'dot-waiting'],
  ['active', 'Active', 'dot-active'],
  ['finished', 'Finished', 'dot-finished'],
];
const DASH = '–';

// Today's tokens and cost, from the 30-day usage stats. `tick` changes on every live event.
function useToday(liveTick) {
  const tick = useThrottledTick(liveTick); // usage is re-read at most every 30 s
  const [today, setToday] = useState(null);
  useEffect(() => {
    let stale = false;
    Promise.resolve()
      .then(() => getUsageStats(30))
      .then(
        (u) => !stale && setToday(u?.periods?.today ?? null),
        () => !stale && setToday(null),
      );
    return () => {
      stale = true;
    };
  }, [tick]);
  return today;
}

function Stat({ label, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Group({ id, name, dot, runs, selectedId, onSelect, collapsible, forceOpen }) {
  const head = (
    <h2 className="group-head" id={`group-${id}`}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{name}</span>
      <span className="group-count">{runs.length}</span>
    </h2>
  );
  const list = <RunList runs={runs} selectedId={selectedId} onSelect={onSelect} />;
  return (
    <section aria-labelledby={`group-${id}`}>
      {collapsible ? (
        <details className="finished" key={forceOpen ? 'open' : 'closed'} open={forceOpen}>
          <summary>{head}</summary>
          {list}
        </details>
      ) : (
        <>
          {head}
          {list}
        </>
      )}
    </section>
  );
}

function AnswerPane({ run, onDone }) {
  if (!run) {
    return (
      <aside className="answer-pane" aria-label="Selected run">
        <p className="muted">Nothing is waiting on you.</p>
      </aside>
    );
  }
  return (
    <aside className="answer-pane" aria-label="Selected run">
      <div className="pane-meta">
        <StatusIcon status="waiting" size={14} />
        <span>{stageLabel(run)}</span>
        <span>
          · <span className="mono">{run.id}</span>
        </span>
        <span>
          · round {run.round}/{run.maxRounds}
        </span>
        <span>
          · <Ago at={run.updatedAt} />
        </span>
      </div>
      <WaitingCard
        key={run.id}
        run={run}
        onDone={onDone}
        pane
        footer={
          <a className="open-run" href={runHref(run.id)}>
            Open run →
          </a>
        }
      />
    </aside>
  );
}

export function Monitor({ groups, query, view, loadError, updatedAt, tick, onDone }) {
  const { waiting, active, finished } = groups;
  const today = useToday(tick);
  const [pick, setPick] = useState(null);
  const selected = waiting.find((r) => r.id === pick) || waiting[0] || null;

  const q = query.trim().toLowerCase();
  const match = (r) => !q || r.title.toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q);
  const shown = { waiting: waiting.filter(match), active: active.filter(match), finished: finished.filter(match) };
  const visible = GROUPS.filter(([id]) => (!view || view === id) && shown[id].length > 0);
  const total = waiting.length + active.length + finished.length;
  const oldest = waiting.reduce((a, r) => (!a || Date.parse(r.updatedAt) < Date.parse(a) ? r.updatedAt : a), null);

  let empty = null;
  if (total === 0) empty = 'No runs yet.';
  else if (visible.length === 0) empty = q ? `No runs match "${query.trim()}".` : 'No runs in this view.';

  return (
    <>
      <header className="page-head">
        <h1>Monitor</h1>
        <span className="muted">Updated {updatedAt ? <Ago at={updatedAt} /> : DASH}</span>
      </header>
      {loadError && (
        <p className="error pad" role="alert">
          Could not load runs: {loadError}
        </p>
      )}
      <section className="stat-strip" aria-label="Today">
        <Stat label="Active runs" value={active.length} />
        <Stat label="Waiting on you" value={waiting.length} sub={oldest ? <>oldest <Ago at={oldest} /></> : null} />
        <Stat label="Tokens today" value={today ? formatTokens(today.total) : DASH} />
        <Stat label="Cost today" value={today ? formatCost(today.cost) : DASH} sub="API-equivalent (estimate)" />
      </section>
      <div className="monitor-body">
        <section className="run-list" aria-label="Runs">
          {empty && <p className="muted pad empty">{empty}</p>}
          {visible.map(([id, name, dot]) => (
            <Group
              key={id}
              id={id}
              name={name}
              dot={dot}
              runs={shown[id]}
              selectedId={selected?.id}
              onSelect={setPick}
              collapsible={id === 'finished'}
              forceOpen={id === 'finished' && (view === 'finished' || !!q)}
            />
          ))}
        </section>
        <AnswerPane run={selected} onDone={onDone} />
      </div>
    </>
  );
}
