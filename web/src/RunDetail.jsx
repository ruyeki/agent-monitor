import { useState } from 'react';
import { stopRun } from './api.js';
import { formatTokens, isEnded } from './lib/format.js';
import { Ago, Idle } from './Ago.jsx';
import { StatusBadge } from './RunsTable.jsx';
import { WorkflowMap } from './WorkflowMap.jsx';

export function StopButton({ run, onDone }) {
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await stopRun(run.id);
      setConfirming(false);
      onDone?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (confirming) {
    return (
      <span className="confirm" role="group" aria-label="Confirm stop">
        <span>Stop run {run.id}?</span>
        <button type="button" className="danger" disabled={busy} onClick={confirm}>
          Confirm
        </button>
        <button type="button" disabled={busy} onClick={() => setConfirming(false)}>
          Cancel
        </button>
        {error && (
          <span className="error" role="alert">
            {error}
          </span>
        )}
      </span>
    );
  }
  return (
    <button type="button" className="danger" disabled={isEnded(run)} onClick={() => setConfirming(true)}>
      Stop
    </button>
  );
}

function AgentsTable({ agents }) {
  if (!agents.length) return <p className="muted">No agents seen yet.</p>;
  return (
    <div className="scroll-x">
      <table className="agents">
        <thead>
          <tr>
            <th>Type</th>
            <th>Model</th>
            <th>Status</th>
            <th>Last tool</th>
            <th>Idle</th>
            <th>Calls</th>
            <th>Errors</th>
            <th>Tokens in / out / cache</th>
          </tr>
        </thead>
        <tbody>
          {agents.map((a) => (
            <tr key={a.id}>
              <td>{a.type}</td>
              <td>{a.model || '-'}</td>
              <td>
                {a.status}
                {a.waitingPermission && <span className="badge status-waiting">waiting for permission</span>}
              </td>
              <td className="tool-cell">
                <span className="mono">{a.lastTool || '-'}</span>
                {a.lastSummary && <div className="muted summary">{a.lastSummary}</div>}
              </td>
              <td>{a.status === 'finished' ? '-' : <Idle since={a.lastActivityAt} />}</td>
              <td>{a.toolCalls}</td>
              <td title={a.lastError || undefined}>{a.errors}</td>
              <td className="mono">
                {formatTokens(a.tokens?.input)} / {formatTokens(a.tokens?.output)} /{' '}
                {formatTokens((a.tokens?.cacheCreation || 0) + (a.tokens?.cacheRead || 0))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RunDetail({ detail, onChanged }) {
  const { run, workflow, timeline = [], agents = [], activity = [] } = detail;
  return (
    <section className="detail" aria-label={`Run ${run.id}`}>
      <header className="detail-head">
        <div>
          <h2>{run.title}</h2>
          <span className="muted mono">{run.id}</span> <StatusBadge status={run.status} />
          {run.repo && (
            <span className="muted">
              {' '}
              · {run.repo}
              {run.branch ? ` @ ${run.branch}` : ''}
            </span>
          )}
        </div>
        <StopButton run={run} onDone={onChanged} />
      </header>
      {run.task && <p className="pre muted">{run.task}</p>}
      {run.note && <p className="pre">{run.note}</p>}

      <h3>Map</h3>
      {workflow ? <WorkflowMap workflow={workflow} run={run} timeline={timeline} /> : <p className="muted">No workflow.</p>}

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

      <h3>Agents</h3>
      <AgentsTable agents={agents} />

      <h3>Recent activity</h3>
      {activity.length === 0 && <p className="muted">No activity yet.</p>}
      <ul className="activity">
        {activity.map((a, i) => (
          <li key={i}>
            <span className="muted"><Ago at={a.at} /></span> <span className="mono">{a.agentId}</span> {a.event}
            {a.tool && <span className="mono"> {a.tool}</span>}
            {a.summary && <span className="muted"> {a.summary}</span>}
          </li>
        ))}
      </ul>
    </section>
  );
}
