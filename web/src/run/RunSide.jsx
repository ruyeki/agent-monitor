import { useEffect, useState } from 'react';
import { Ago, Idle } from '../Ago.jsx';
import { formatCost, formatDuration, formatTokens } from '../lib/format.js';
import { pillLabel, toolCalls } from '../lib/toolCalls.js';
import { StatusBadge, stageLabel } from '../RunList.jsx';
import { StopButton } from '../StopButton.jsx';
import { WaitingCard } from '../WaitingCards.jsx';
import { ThinkingLoader } from '../vendor/affectui/thinking-loader.tsx';
import { ToolCallCard } from '../vendor/affectui/tool-call-card.tsx';

// A clock for the working/running rules, which depend on how old the last activity is.
function useNow(every) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), every);
    return () => clearInterval(t);
  }, [every]);
  return now;
}

function ActiveAgents({ detail, now }) {
  const { run, agents = [] } = detail;
  const running = agents.filter((a) => a.status === 'running');
  if (!running.length) return <p className="muted">No agent is running.</p>;
  return (
    <ul className="agent-list">
      {running.map((a) => {
        const label = pillLabel(detail, a, now, stageLabel(run));
        return (
          <li key={a.id}>
            <strong>{a.type}</strong>
            {a.description && <span className="muted"> {a.description}</span>}
            <div className="muted">
              {a.provider === 'codex' && <span className="badge codex">Codex</span>} {a.model || 'model unknown'} · idle <Idle since={a.lastActivityAt} />
              {a.waitingPermission && <span className="badge status-waiting">waiting for permission</span>}
            </div>
            {a.lastTool && (
              <div>
                <span className="mono">{a.lastTool}</span>
                {a.lastSummary && <span className="muted summary"> {a.lastSummary}</span>}
              </div>
            )}
            {label && (
              <div className="agent-pill">
                <ThinkingLoader size="sm" phases={[label]} />
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

// Run token figures: the total's breakdown, the main session apart from the stages, and the estimate.
function RunTokens({ tokens }) {
  const t = tokens.total || {};
  return (
    <div className="run-tokens">
      <p className="muted">
        Input {formatTokens(t.input)} · Output {formatTokens(t.output)} · Cache write {formatTokens(t.cacheWrite)} · Cache read {formatTokens(t.cacheRead)}
      </p>
      <p>
        Main session (not on any stage): <strong>{formatTokens(tokens.main?.total)}</strong>
      </p>
      {tokens.unattributed?.total > 0 && (
        <p>
          Unattributed: <strong>{formatTokens(tokens.unattributed.total)}</strong>
        </p>
      )}
      <p className="muted">≈ {formatCost(t.cost)} API-equivalent (estimate)</p>
    </div>
  );
}

const when = (iso) => new Date(iso).toLocaleString();

// Codex hand-off: when Claude's usage ran out, and what Codex has used since (tokens only; $ only when a price row gave a cost).
function CodexInfo({ run, codex }) {
  const t = codex || {};
  return (
    <section aria-label="Codex">
      <h3>Codex</h3>
      <p>
        {run.limitAt ? `Claude usage ran out ${when(run.limitAt)}` : 'Handed over to Codex'}
        {run.resetsAt ? `, resets ${when(run.resetsAt)}` : ''}
      </p>
      <p>
        Codex tokens: <strong>{formatTokens(t.total)}</strong>
        {t.cost > 0 && <span className="muted"> · ≈ {formatCost(t.cost)} (estimate)</span>}
      </p>
      <p className="muted">
        Input {formatTokens(t.input)} · Output {formatTokens(t.output)} · Cache read {formatTokens(t.cacheRead)}
        {t.unpriced > 0 && ' · no price for this model'}
      </p>
    </section>
  );
}

// Side panel of the run view: what is happening now, the timeline and the totals.
export function RunSide({ detail, onChanged }) {
  const { run, timeline = [] } = detail;
  const now = useNow(10000);
  const calls = toolCalls(detail, now);
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
      {run.provider === 'codex' && <CodexInfo run={run} codex={detail.tokens?.codex} />}
      <section aria-label="Active agents">
        <h3>Active agents</h3>
        <ActiveAgents detail={detail} now={now} />
      </section>
      <section aria-label="Tool calls">
        <h3>Tool calls</h3>
        {calls.length ? (
          <div className="tool-calls">
            {calls.map((c) => (
              <ToolCallCard
                key={c.id}
                name={c.tool || 'tool'}
                summary={c.summary || undefined}
                agent={c.agent ?? undefined}
                status={c.status}
                startedAt={Date.parse(c.at)}
                duration={c.durationMs ?? undefined}
                error={c.error ?? undefined}
                openOnError={false}
              >
                <div className="tool-call-details">
                  {c.summary && <p className="tool-call-summary">{c.summary}</p>}
                  <p className="muted">
                    Agent <span className="mono">{c.agent ?? 'unknown'}</span> · started {when(c.at)}
                  </p>
                </div>
              </ToolCallCard>
            ))}
          </div>
        ) : (
          <p className="muted">No tool calls yet.</p>
        )}
      </section>
      <section aria-label="Totals">
        <h3>Totals</h3>
        <p>
          Tokens: <strong>{formatTokens(detail.tokens.total.total)}</strong> · Duration: <strong>{formatDuration(detail.durationMs)}</strong>
        </p>
        <RunTokens tokens={detail.tokens} />
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
