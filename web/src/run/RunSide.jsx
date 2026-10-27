import { Ago, Idle } from '../Ago.jsx';
import { formatDuration, formatTokens } from '../lib/format.js';
import { StatusBadge } from '../RunsTable.jsx';
import { StopButton } from '../StopButton.jsx';
import { WaitingCard } from '../WaitingCards.jsx';

const sumTokens = (agents) =>
  agents.reduce((n, a) => n + (a.tokens?.input || 0) + (a.tokens?.output || 0) + (a.tokens?.cacheCreation || 0) + (a.tokens?.cacheRead || 0), 0);

function ActiveAgents({ agents }) {
  const running = agents.filter((a) => a.status === 'running');
  if (!running.length) return <p className="muted">No agent is running.</p>;
  return (
    <ul className="agent-list">
      {running.map((a) => (
        <li key={a.id}>
          <strong>{a.type}</strong>
          {a.description && <span className="muted"> {a.description}</span>}
          <div className="muted">
            {a.model || 'model unknown'} · idle <Idle since={a.lastActivityAt} />
            {a.waitingPermission && <span className="badge status-waiting">waiting for permission</span>}
          </div>
          {a.lastTool && (
            <div>
              <span className="mono">{a.lastTool}</span>
              {a.lastSummary && <span className="muted summary"> {a.lastSummary}</span>}
            </div>
          )}
        </li>
      ))}
    </ul>
  );
}

// Side panel of the run view: what is happening now, the timeline and the totals.
export function RunSide({ detail, onChanged }) {
  const { run, timeline = [], agents = [], activity = [] } = detail;
  const last = activity[0];
  const total = detail.tokens?.total ?? sumTokens(agents);
  return (
    <aside className="run-side" aria-label="Run details">
      <section aria-label="Status">
        <h3>Status</h3>
        <StatusBadge status={run.status} /> <span className="muted">round {run.round}/{run.maxRounds}</span>
        <div>
          {(run.active ?? []).length > 0 ? `At: ${run.active.map((a) => a.name || a.id).join(', ')}` : run.stageName || run.stage}
        </div>
        <p>
          <StopButton run={run} onDone={onChanged} />
        </p>
      </section>
      {run.status === 'waiting' && <WaitingCard run={run} onDone={onChanged} />}
      <section aria-label="Active agents">
        <h3>Active agents</h3>
        <ActiveAgents agents={agents} />
      </section>
      <section aria-label="Last activity">
        <h3>Last activity</h3>
        {last ? (
          <p>
            <span className="muted"><Ago at={last.at} /></span> <span className="mono">{last.agentId}</span> {last.event}
            {last.tool && <span className="mono"> {last.tool}</span>}
            {last.summary && <span className="muted summary"> {last.summary}</span>}
          </p>
        ) : (
          <p className="muted">No activity yet.</p>
        )}
      </section>
      <section aria-label="Totals">
        <h3>Totals</h3>
        <p>
          Tokens: <strong>{formatTokens(total)}</strong> · Duration: <strong>{formatDuration(detail.durationMs)}</strong>
        </p>
      </section>
      <section aria-label="Timeline">
        <h3>Timeline</h3>
        {timeline.length === 0 && <p className="muted">No events yet.</p>}
        <ol className="timeline">
          {timeline.map((e, i) => (
            <li key={i}>
              <span className="muted"><Ago at={e.at} /></span> <strong>{e.kind}</strong>
              {e.stage && <> {e.stage}</>}
              {e.verdict && <> · {e.verdict}</>}
              {e.round > 0 && <> · round {e.round}</>}
              {e.note && <div className="pre">{e.note}</div>}
            </li>
          ))}
        </ol>
      </section>
    </aside>
  );
}
