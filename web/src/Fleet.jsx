import { Fragment, useEffect, useRef, useState } from 'react';
import { respond } from './api.js';
import { Elapsed } from './Ago.jsx';
import { agentCall, agentName, modelLabel, nowWorking, sortCrew } from './lib/crew.js';
import { parseAsk } from './lib/ask.js';
import { formatCost, roundsLabel } from './lib/format.js';
import { runHref } from './lib/route.js';
import { CodexTag, stageLabel } from './RunList.jsx';
import { AgentPill, Avatar, Avatars, StageStepper, StatusPill } from './RunBits.jsx';

// A clock for the working rules (how old the last activity is).
function useNow(every) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

const costOf = (detail) => (detail?.tokens?.total ? formatCost(detail.tokens.total.cost) : '–');
const agentsOf = (detail) => (Array.isArray(detail?.agents) ? detail.agents : []);

// One answer button per gate action; the answer goes out with an empty reply (the inbox and the run page take text).
function QuickAnswers({ run, onDone }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(null);
  const answer = async (label) => {
    setSending(true);
    setError(null);
    try {
      await respond(run.id, label, '');
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };
  const actions = run.actions || [];
  if (!actions.length) return null;
  return (
    <>
      <div className="rc-actions">
        {actions.map((a, i) => (
          <button key={`${i}:${a.label}`} type="button" className={i === 0 ? 'primary sm' : 'sm'} disabled={sending} onClick={() => answer(a.label)}>
            {a.label}
          </button>
        ))}
      </div>
      {error && (
        <p className="error rc-error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

function RunCard({ run, detail, open, onToggle, toggleRef, onDone, now }) {
  const waiting = run.status === 'waiting';
  const agents = agentsOf(detail);
  const work = !waiting && detail ? nowWorking(detail, now) : null;
  const heading = waiting ? parseAsk(run.ask).heading : '';
  const stripId = `crew-${run.id}`;
  // A click (or Enter / Space) anywhere on the card that is not on one of its own controls toggles the crew strip.
  const own = (e) => !e.target.closest?.('button, a, textarea, input, select');
  const onCardClick = (e) => own(e) && onToggle();
  const onCardKey = (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && own(e)) {
      e.preventDefault();
      onToggle();
    }
  };
  // Enter toggles on keydown (and cancels the button's own click); Space keeps the native click.
  const onToggleKey = (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onToggle();
    }
  };
  return (
    <article className={open ? 'card rc sel' : 'card rc'} data-run-id={run.id} onClick={onCardClick} onKeyDown={onCardKey}>
      <div className="rc-top">
        <StatusPill status={run.status} />
        <span className="mono faint rc-id">{run.id}</span>
      </div>
      <h2 className="rc-title">
        <button type="button" className="rc-toggle" ref={toggleRef} aria-expanded={open} aria-controls={open ? stripId : undefined} onClick={onToggle} onKeyDown={onToggleKey}>
          {run.title}
        </button>
        <CodexTag run={run} />
      </h2>
      <div className="rc-stage">
        <StageStepper detail={detail} />
        <span className="small muted">
          {stageLabel(run)} · round {roundsLabel(run)}
        </span>
      </div>
      {waiting ? (
        <>
          {heading && <p className="ask">{heading}</p>}
          <QuickAnswers run={run} onDone={onDone} />
        </>
      ) : (
        <div className="act">
          {work ? (
            <>
              <span className="ring" aria-hidden="true" />
              <span className="act-text">
                <b>{work.name}</b> {work.call}
              </span>
            </>
          ) : (
            <span className="act-text faint">{detail ? 'No agent is working right now' : 'Loading activity…'}</span>
          )}
        </div>
      )}
      <div className="rcfoot">
        <Avatars agents={agents} />
        <span className="rc-figures">
          {agents.length > 0 && `${agents.length} ${agents.length === 1 ? 'agent' : 'agents'} · `}
          {costOf(detail)} · <Elapsed from={run.createdAt} />
        </span>
      </div>
    </article>
  );
}

// The crew of one run, under its card's grid row: every agent with role, status, task or current call, model and cost.
function CrewStrip({ run, detail, now }) {
  const crew = sortCrew(agentsOf(detail));
  const working = crew.filter((a) => a.status === 'running').length;
  return (
    <section className="card crew-strip" id={`crew-${run.id}`} aria-label={`Crew of ${run.id}`}>
      <div className="crew-head">
        <h2>
          Crew · <span className="mono muted">{run.id}</span>
        </h2>
        <div className="hgroup small">
          <span className="muted">
            {crew.length} {crew.length === 1 ? 'agent' : 'agents'}
          </span>
          {working > 0 && <span className="live-text">{working} working</span>}
          <a className="link" href={runHref(run.id, 'crew')}>
            Open run →
          </a>
        </div>
      </div>
      {!detail ? (
        <p className="muted small">Loading crew…</p>
      ) : !crew.length ? (
        <p className="muted small">No agents yet.</p>
      ) : (
        <ul className="crew-cards">
          {crew.map((a) => (
            <li key={a.id} className={a.status === 'running' ? 'crew-card on' : 'crew-card'} data-agent-id={a.id}>
              <div className="crew-card-head">
                <Avatar agent={a} />
                <span className="strong crew-name">{agentName(a)}</span>
                <AgentPill agent={a} />
              </div>
              <span className="small muted crew-task">{agentCall(detail, a, now) || a.description || '–'}</span>
              <span className="small faint">
                {modelLabel(a.model)} · {formatCost(a.tokens?.cost)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const byAge = (a, b) => (Date.parse(a.updatedAt) || 0) - (Date.parse(b.updatedAt) || 0);

// The Fleet layout (contract C2): one card per live run, waiting ones first (oldest first), then the running ones.
// Waiting cards are never hidden by search or views (like the inbox); running cards follow both. A card's crew strip
// opens under its grid row (the grid packs densely, so the full-width strip drops below the row); one at a time; Escape closes it.
export function Fleet({ waiting, active, detailOf, query, view, empty, onDone }) {
  const [openId, setOpenId] = useState(null);
  const toggles = useRef(new Map());
  const now = useNow(10000);
  const match = (r) => !query || r.title.toLowerCase().includes(query) || String(r.id).toLowerCase().includes(query);
  const runs = [...[...waiting].sort(byAge), ...(!view || view === 'active' ? active.filter(match) : [])];
  const open = runs.some((r) => r.id === openId) ? openId : null;

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.target.closest?.('input, textarea, select')) return;
      const strip = document.getElementById(`crew-${open}`);
      const btn = toggles.current.get(open);
      const inside = strip?.contains(document.activeElement) || btn === document.activeElement;
      setOpenId(null);
      if (inside) btn?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!runs.length) {
    return <p className="muted empty">{empty ? 'No runs yet.' : waiting.length + active.length ? 'No live runs in this view.' : 'No live runs.'}</p>;
  }
  return (
    <section className="fleet" aria-label="Live runs">
      {runs.map((r) => (
        <Fragment key={r.id}>
          <RunCard
            run={r}
            detail={detailOf(r.id)}
            open={open === r.id}
            onToggle={() => setOpenId((id) => (id === r.id ? null : r.id))}
            toggleRef={(el) => (el ? toggles.current.set(r.id, el) : toggles.current.delete(r.id))}
            onDone={onDone}
            now={now}
          />
          {open === r.id && <CrewStrip run={r} detail={detailOf(r.id)} now={now} />}
        </Fragment>
      ))}
    </section>
  );
}
