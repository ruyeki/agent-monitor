import { useEffect, useState } from 'react';
import { getUsageStats, respond } from './api.js';
import { useLayout, useRunDetails, useThrottledTick } from './hooks.js';
import { Ago } from './Ago.jsx';
import { EndConfirm } from './EndConfirm.jsx';
import { Fleet } from './Fleet.jsx';
import { formatCost, formatTokens } from './lib/format.js';
import { runHref } from './lib/route.js';
import { CodexTag, RunList, StatusIcon, stageLabel } from './RunList.jsx';
import { VIEWS } from './Sidebar.jsx';
import { Ask } from './WaitingCards.jsx';
import { DecisionInbox } from './vendor/affectui/decision-inbox.tsx';

const GROUPS = [
  ['active', 'Running', 'dot-active'],
  ['finished', 'Finished', 'dot-finished'],
];
const DASH = '–';
const FINISHED_PAGE = 8; // finished rows shown at a time; each shown row fetches its detail once

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

function Stat({ label, dot, value, sub }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {dot && <span className={`dot ${dot}`} aria-hidden="true" />}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

const ListIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);
const GridIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden="true">
    <rect x="3" y="3" width="7" height="7" rx="1.5" />
    <rect x="14" y="3" width="7" height="7" rx="1.5" />
    <rect x="3" y="14" width="7" height="7" rx="1.5" />
    <rect x="14" y="14" width="7" height="7" rx="1.5" />
  </svg>
);

// List / Fleet (contract C1): a segmented pair of toggle buttons.
export function LayoutToggle({ layout, onChange }) {
  return (
    <div className="seg" role="group" aria-label="Layout">
      {[
        ['list', 'List', <ListIcon key="i" />],
        ['fleet', 'Fleet', <GridIcon key="i" />],
      ].map(([id, label, icon]) => (
        <button key={id} type="button" aria-pressed={layout === id} className={layout === id ? 'on' : ''} onClick={() => onChange(id)}>
          {icon}
          {label}
        </button>
      ))}
    </div>
  );
}

function Group({ id, name, dot, runs, detailOf, collapsible, forceOpen, onOpen, more, onMore }) {
  const head = (
    <h2 className="group-head" id={`group-${id}`}>
      <span className={`dot ${dot}`} aria-hidden="true" />
      <span>{name}</span>
      <span className="group-count">{runs.length}</span>
    </h2>
  );
  const list = (
    <div className="run-card">
      <RunList runs={runs.slice(0, collapsible ? more : runs.length)} detailOf={detailOf} />
      {collapsible && runs.length > more && (
        <div className="show-more">
          <button type="button" className="ghost sm" onClick={onMore}>
            Show {Math.min(FINISHED_PAGE, runs.length - more)} more
          </button>
        </div>
      )}
    </div>
  );
  return (
    <section className="run-group" aria-labelledby={`group-${id}`}>
      {collapsible ? (
        <details className="finished" key={forceOpen ? 'open' : 'closed'} open={forceOpen} onToggle={(e) => onOpen(e.currentTarget.open)}>
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
            <span className="pill wait pane-stage">
              <StatusIcon status="waiting" size={12} />
              {stageLabel(run)}
            </span>
            <span className="mono">{run.id}</span>
            <span>
              round {run.round}/{run.maxRounds}
            </span>
            <span>
              <Ago at={run.updatedAt} />
            </span>
          </div>
          <Ask text={run.ask} />
        </>
      ),
      actions: (run.actions || []).map((a) => a.label),
      ends: (run.actions || []).filter((a) => a.ends).map((a) => a.label),
      renderConfirm: (p) => <EndConfirm {...p} />,
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

// Running agents across the live runs, once their details are in; null while none is.
function agentsWorking(runs, detailOf) {
  let known = false;
  let n = 0;
  for (const r of runs) {
    const d = detailOf(r.id);
    if (!Array.isArray(d?.agents)) continue;
    known = true;
    n += d.agents.filter((a) => a?.status === 'running').length;
  }
  return known ? n : null;
}

const cacheShare = (t) => (t && Number(t.total) > 0 && t.cacheRead != null ? Math.round((100 * Number(t.cacheRead)) / Number(t.total)) : null);

export function Monitor({ groups, query, view, loadError, updatedAt, tick, onDone }) {
  const { waiting, active, finished } = groups;
  const today = useToday(tick);
  const [savedLayout, setLayout] = useLayout();
  // Finished is always a list; the saved preference is left alone so the other views come back as the user set them.
  const layout = view === 'finished' ? 'list' : savedLayout;
  const [finishedOpen, setFinishedOpen] = useState(false);
  const [more, setMore] = useState(FINISHED_PAGE);

  // The run list holds active and finished runs; waiting runs live in the inbox, which search and views never filter.
  const q = query.trim().toLowerCase();
  const match = (r) => !q || r.title.toLowerCase().includes(q) || String(r.id).toLowerCase().includes(q);
  const shown = { active: active.filter(match), finished: finished.filter(match) };
  const visible = GROUPS.filter(([id]) => (!view || view === id) && shown[id].length > 0);
  const total = waiting.length + active.length + finished.length;
  const oldest = waiting.reduce((a, r) => (!a || Date.parse(r.updatedAt) < Date.parse(a) ? r.updatedAt : a), null);
  const inboxOnly = view === 'waiting';
  const forceOpen = view === 'finished' || !!q;
  useEffect(() => {
    if (!forceOpen) setFinishedOpen(false); // the group re-mounts closed when the forced-open state ends
  }, [forceOpen]);
  const finishedShown = layout === 'list' && !inboxOnly && (finishedOpen || forceOpen) && visible.some(([id]) => id === 'finished') ? shown.finished.slice(0, more) : [];
  const detailOf = useRunDetails([...waiting, ...active], finishedShown, tick);

  // A view has its own empty texts; with no view the old ones stay.
  const noMatch = `No runs match "${query.trim()}".`;
  let empty = null;
  if (view === 'waiting') empty = 'Nothing is waiting on you.'; // the list shows the inbox's own text instead
  else if (view) {
    const pool = view === 'active' ? active : finished;
    if (pool.length === 0) empty = view === 'active' ? 'Nothing is running.' : 'No finished runs.';
    else if (shown[view].length === 0) empty = noMatch;
  } else if (total === 0) empty = 'No runs yet.';
  else if (visible.length === 0) empty = q ? noMatch : 'No active or finished runs.';

  const working = agentsWorking([...waiting, ...active], detailOf);
  const cache = cacheShare(today);
  // The inbox (the question that needs the user) comes before the summary numbers while something is waiting. The inbox
  // always sits first inside .monitor-body, so an answered question's confirmation is not remounted when the last
  // waiting run leaves and the numbers move back above it.
  const statsFirst = !view && waiting.length === 0;
  const statsInBody = !view && waiting.length > 0;
  const stats = (
    <section className="stat-strip" aria-label="Today">
      <Stat label="Running" dot="dot-active" value={active.length} sub={working != null ? `${working} ${working === 1 ? 'agent' : 'agents'} working` : null} />
      <Stat label="Needs you" dot="dot-waiting" value={waiting.length} sub={oldest ? <>oldest <Ago at={oldest} /></> : null} />
      <Stat label="Spend today" value={today ? formatCost(today.cost) : DASH} sub="API-equivalent estimate" />
      <Stat label="Tokens today" value={today ? formatTokens(today.total) : DASH} sub={cache != null ? `${cache}% cache reads` : null} />
    </section>
  );
  const inboxPane = (
    <aside className="inbox-pane" aria-label="Decision inbox">
      <Inbox waiting={waiting} onDone={onDone} />
      {waiting.length > 0 && <p className="inbox-note">Answered questions confirm, then fold away.</p>}
    </aside>
  );

  return (
    <>
      <header className="page-head">
        <div className="hgroup">
          <h1>{view ? VIEWS.find(([id]) => id === view)?.[1] : 'Monitor'}</h1>
          {view !== 'finished' && <LayoutToggle layout={layout} onChange={setLayout} />}
        </div>
        {layout === 'list' || view ? (
          <span className="faint small">Updated {updatedAt ? <Ago at={updatedAt} /> : DASH}</span>
        ) : (
          <div className="hgroup small fleet-summary">
            <span className="muted">
              {waiting.length + active.length} live {waiting.length + active.length === 1 ? 'run' : 'runs'}
            </span>
            <span className="sep" aria-hidden="true" />
            <span className="live-text">{active.length} running</span>
            {waiting.length > 0 && (
              <>
                <span className="sep" aria-hidden="true" />
                <span className="pill wait">{waiting.length} need you</span>
              </>
            )}
            <span className="sep" aria-hidden="true" />
            <strong>{today ? formatCost(today.cost) : DASH} today</strong>
          </div>
        )}
      </header>
      {loadError && (
        <p className="error" role="alert">
          Could not load runs: {loadError}
        </p>
      )}
      {layout === 'fleet' ? (
        <Fleet waiting={waiting} active={active} detailOf={detailOf} query={q} view={view} empty={total === 0} emptyText={view ? empty : null} onDone={onDone} />
      ) : (
        <>
          {statsFirst && stats}
          <div className={inboxOnly ? 'monitor-body inbox-only' : 'monitor-body'}>
            {(!view || inboxOnly) && inboxPane}
            {statsInBody && stats}
            {!inboxOnly && (
              <section className="run-list" aria-label="Runs">
                {empty && <p className="muted empty">{empty}</p>}
                {visible.map(([id, name, dot]) => (
                  <Group
                    key={id}
                    id={id}
                    name={name}
                    dot={dot}
                    runs={shown[id]}
                    detailOf={detailOf}
                    collapsible={id === 'finished'}
                    forceOpen={id === 'finished' && forceOpen}
                    onOpen={setFinishedOpen}
                    more={more}
                    onMore={() => setMore((m) => m + FINISHED_PAGE)}
                  />
                ))}
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}
