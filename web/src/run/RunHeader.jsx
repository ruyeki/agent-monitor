import { Elapsed } from '../Ago.jsx';
import { formatCost, isEnded, roundsLabel } from '../lib/format.js';
import { runHref } from '../lib/route.js';
import { CodexTag, stageLabel } from '../RunList.jsx';
import { StatusPill } from '../RunBits.jsx';
import { StopButton } from '../StopButton.jsx';

// The tabs of the run view, in this order.
const TABS = [['crew', 'Crew'], ['stages', 'Stages'], ['ledger', 'Ledger']];

// Shared header of every run tab (contract C5): breadcrumb, title, status, stage, agents, cost, run time, Stop run, tabs.
export function RunHeader({ detail, tab = 'stages', error, onChanged }) {
  const { run } = detail;
  const live = !isEnded(run);
  const agents = Array.isArray(detail.agents) ? detail.agents.length : 0;
  return (
    <header className="page-head run-head">
      <nav className="crumb" aria-label="Breadcrumb">
        <a href="#/">Monitor</a>
        <span aria-hidden="true">/</span>
        <span className="mono">{run.id}</span>
      </nav>
      <div className="run-head-row">
        <div className="hgroup">
          <h1>{run.title}</h1>
          <StatusPill status={run.status} />
          {live && (
            <span className="chip">
              {stageLabel(run)} · round {roundsLabel(run)}
            </span>
          )}
          <CodexTag run={run} />
        </div>
        <div className="hgroup small run-figures">
          <span className="muted">
            {agents} {agents === 1 ? 'agent' : 'agents'}
          </span>
          <span className="sep" aria-hidden="true" />
          <strong>{formatCost(detail.tokens?.total?.cost)}</strong>
          <span className="sep" aria-hidden="true" />
          <span className="muted">
            <Elapsed from={run.createdAt} to={live ? null : run.endedAt || run.updatedAt} />
          </span>
          {live && <StopButton run={run} onDone={onChanged} />}
        </div>
      </div>
      {(run.repo || error) && (
        <div className="run-head-notes small">
          {run.repo && (
            <span className="muted">
              {run.repo}
              {run.branch ? ` @ ${run.branch}` : ''}
            </span>
          )}
          {error && (
            <span className="error" role="alert">
              Out of date: {error}
            </span>
          )}
        </div>
      )}
      <div className="tabs" role="tablist" aria-label="Run views">
        {TABS.map(([id, label]) => (
          <a key={id} id={`tab-${id}`} role="tab" href={runHref(run.id, id)} aria-selected={tab === id} aria-controls={`panel-${id}`} className={tab === id ? 'on' : ''}>
            {label}
          </a>
        ))}
      </div>
    </header>
  );
}
