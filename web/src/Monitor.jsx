import { useEffect, useState } from 'react';
import { getUsageStats, respond } from './api.js';
import { useThrottledTick } from './hooks.js';
import { Ago } from './Ago.jsx';
import { formatCost, formatTokens } from './lib/format.js';
import { runHref } from './lib/route.js';
import { CodexTag, RunList, StatusIcon, stageLabel } from './RunList.jsx';
import { Ask } from './WaitingCards.jsx';
import { DecisionInbox } from './vendor/affectui/decision-inbox.tsx';

const GROUPS = [
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

function Group({ id, name, dot, runs, collapsible, forceOpen }) {
  const head = (
    <h2 className="group-head" id={`group-${id}`}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{name}</span>
      <span className="group-count">{runs.length}</span>
    </h2>
  );
  const list = <RunList runs={runs} />;
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

// One decision per waiting question: the same run waiting again on another question is a new decision (in the run's row).
const askId = (r) => JSON.stringify([r.id, r.stage, r.ask ?? '']);
const byAge = (a, b) => (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0);

// The waiting runs as a decision inbox, oldest first. Reply text is kept per decision until it stops waiting.
function Inbox({ waiting, onDone }) {
  const [replies, setReplies] = useState({});
  const runs = [...waiting].sort(byAge);
  const ids = runs.map(askId);
  const idKey = ids.join('\n');
  useEffect(() => {
    const live = new Set(idKey.split('\n'));
    setReplies((r) => (Object.keys(r).every((k) => live.has(k)) ? r : Object.fromEntries(Object.entries(r).filter(([k]) => live.has(k)))));
  }, [idKey]);

  const runOf = new Map(runs.map((r, i) => [ids[i], r]));
  const decide = async (d, action) => {
    await respond(runOf.get(d.id).id, action, replies[d.id] ?? '');
    onDone?.();
  };
  const decisions = runs.map((run, i) => {
    const id = ids[i];
    return {
      id,
      rowKey: run.id,
      label: run.title,
      title: (
        <>
          {run.title}
          <CodexTag run={run} />
        </>
      ),
      detail: (
        <>
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
          <Ask text={run.ask} />
        </>
      ),
      actions: (run.actions || []).map((a) => a.label),
      extra: run.textField
        ? ({ disabled }) => (
            <textarea
              aria-label={`Reply for ${run.title}`}
              rows={3}
              value={replies[id] ?? ''}
              disabled={disabled}
              onChange={(e) => {
                const v = e.target.value;
                setReplies((r) => ({ ...r, [id]: v }));
              }}
              placeholder="Your reply (optional)"
            />
          )
        : null,
      footer: (
        <a className="open-run" href={runHref(run.id)}>
          Open run →
        </a>
      ),
      rowProps: { 'aria-label': `Waiting on you: ${run.title}`, 'data-run-id': run.id },
    };
  });
  return <DecisionInbox decisions={decisions} onDecide={decide} />;
}

export function Monitor({ groups, query, view, loadError, updatedAt, tick, onDone }) {
  const { waiting, active, finished } = groups;
  const today = useToday(tick);

  // The run list holds active and finished runs; waiting runs live in the inbox, which search and views never filter.
  const q = query.trim().toLowerCase();
  const match = (r) => !q || r.title.toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q);
  const shown = { active: active.filter(match), finished: finished.filter(match) };
  const visible = GROUPS.filter(([id]) => (!view || view === id) && shown[id].length > 0);
  const total = waiting.length + active.length + finished.length;
  const oldest = waiting.reduce((a, r) => (!a || Date.parse(r.updatedAt) < Date.parse(a) ? r.updatedAt : a), null);
  const inboxOnly = view === 'waiting';

  let empty = null;
  if (total === 0) empty = 'No runs yet.';
  else if (visible.length === 0) empty = q ? `No runs match "${query.trim()}".` : view ? 'No runs in this view.' : 'No active or finished runs.';

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
      <div className={inboxOnly ? 'monitor-body inbox-only' : 'monitor-body'}>
        {!inboxOnly && (
          <section className="run-list" aria-label="Runs">
            {empty && <p className="muted pad empty">{empty}</p>}
            {visible.map(([id, name, dot]) => (
              <Group
                key={id}
                id={id}
                name={name}
                dot={dot}
                runs={shown[id]}
                collapsible={id === 'finished'}
                forceOpen={id === 'finished' && (view === 'finished' || !!q)}
              />
            ))}
          </section>
        )}
        <aside className="inbox-pane" aria-label="Decision inbox">
          <Inbox waiting={waiting} onDone={onDone} />
        </aside>
      </div>
    </>
  );
}
