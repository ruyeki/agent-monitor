import { useNow } from '../hooks.js';
import { Ago } from '../Ago.jsx';
import { formatCost, formatDuration, formatElapsed, formatTokens } from '../lib/format.js';
import { pillLabel, toolCalls } from '../lib/toolCalls.js';
import { agentLabels, agentName, modelLabel } from '../lib/crew.js';
import { toMs } from '../lib/time.js';
import { stageLabel } from '../RunList.jsx';
import { Avatar, StatusPill } from '../RunBits.jsx';
import { WaitingCard } from '../WaitingCards.jsx';
import { ThinkingLoader } from '../vendor/affectui/thinking-loader.tsx';
import { ToolCallCard } from '../vendor/affectui/tool-call-card.tsx';

const QUIET_MS = 60_000; // a running agent is called quiet only after a full minute without activity

// "no activity for 2m", or nothing while the agent has been active within the last minute ("idle 14s" read like a stall).
function Quiet({ since, now }) {
  const t = toMs(since);
  return t != null && now - t >= QUIET_MS ? <> · no activity for {formatElapsed(now - t)}</> : null;
}

function ActiveAgents({ detail, now }) {
  const { run, agents = [] } = detail;
  const running = agents.filter((a) => a.status === 'running');
  if (!running.length) return <p className="muted">No agent is running.</p>;
  const labels = agentLabels(agents);
  return (
    <ul className="agent-list">
      {running.map((a) => {
        const label = pillLabel(detail, a, now, stageLabel(run));
        const name = labels.get(a.id) ?? agentName(a);
        return (
          <li key={a.id} className="agent-item">
            <div className="agent-line">
              <Avatar agent={a} />
              <strong>{name}</strong>
              {a.description && a.description !== name && <span className="muted agent-desc"> {a.description}</span>}
            </div>
            <div className="muted small">
              {a.provider === 'codex' && <span className="badge codex">Codex</span>} {modelLabel(a.model)}
              <Quiet since={a.lastActivityAt} now={now} />
              {a.waitingPermission && <span className="badge status-waiting">waiting for permission</span>}
            </div>
            {a.lastTool && (
              <div className="agent-last">
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

// The run's totals, one design for the Crew and Stages tabs: big figures (tokens, cost, time), the breakdown, the main
// session apart from the stages. A cost that is not known yet reads "–" with a note, never "$0.00".
export function Totals({ detail }) {
  const tokens = detail.tokens || {};
  const t = tokens.total || {};
  const agents = Array.isArray(detail.agents) ? detail.agents : [];
  const agentTokens = agents.reduce((n, a) => n + (Number(a?.tokens?.total) || 0), 0);
  const unpriced = !(Number(t.total) > 0) && agentTokens > 0; // agents report tokens, the run total is not in yet
  return (
    <section className="card side-card" aria-label="Totals">
      <div className="cardhead">
        <h3>Totals</h3>
        <span className="muted small">API-equivalent estimate</span>
      </div>
      <div className="pad totals-grid">
        <div>
          <div className="muted small">Tokens</div>
          <strong className="big">{formatTokens(unpriced ? agentTokens : t.total)}</strong>
        </div>
        <div>
          <div className="muted small">Cost</div>
          <strong className="big">{unpriced ? '–' : formatCost(t.cost)}</strong>
        </div>
        <div>
          <div className="muted small">Duration</div>
          <strong className="big">{formatDuration(detail.durationMs)}</strong>
        </div>
        {unpriced && <p className="muted small totals-split">Not priced yet: the agents report tokens, but the run's cost is not worked out.</p>}
        <p className="muted small totals-split">
          Input {formatTokens(t.input)} · Output {formatTokens(t.output)} · Cache write {formatTokens(t.cacheWrite)} · Cache read {formatTokens(t.cacheRead)}
        </p>
        <p className="small totals-split">
          Main session (not on any stage): <strong>{formatTokens(tokens.main?.total)}</strong>
        </p>
        {tokens.unattributed?.total > 0 && (
          <p className="small totals-split">
            Unattributed: <strong>{formatTokens(tokens.unattributed.total)}</strong>
          </p>
        )}
      </div>
    </section>
  );
}

const when = (iso) => new Date(iso).toLocaleString();

// The tool-call cards (vendored ToolCallCard), newest first; shared by the Stages and Crew tabs.
// `agents` names each call's agent by its distinguishing label; `hideAgent` drops the agent column when the list is
// already filtered to one agent.
export function ToolCallList({ calls, empty = 'No tool calls yet.', agents, hideAgent = false }) {
  if (!calls.length) return <p className="muted">{empty}</p>;
  const labels = agentLabels(agents);
  const who = (c) => labels.get(c.agentId) ?? c.agent;
  return (
    <div className="tool-calls">
      {calls.map((c) => (
        <ToolCallCard
          key={c.id}
          name={c.tool || 'tool'}
          summary={c.summary || undefined}
          agent={hideAgent ? undefined : who(c) ?? undefined}
          status={c.status}
          startedAt={Date.parse(c.at)}
          duration={c.durationMs ?? undefined}
          error={c.error ?? undefined}
          openOnError={false}
        >
          <div className="tool-call-details">
            {c.summary && <p className="tool-call-summary">{c.summary}</p>}
            <p className="muted">
              Agent <span className="mono">{who(c) ?? 'unknown'}</span> · started {when(c.at)}
            </p>
          </div>
        </ToolCallCard>
      ))}
    </div>
  );
}

// Codex hand-off: when Claude's usage ran out, and what Codex has used since (tokens only; $ only when a price row gave a cost).
function CodexInfo({ run, codex }) {
  const t = codex || {};
  return (
    <section className="card side-card" aria-label="Codex">
      <div className="cardhead">
        <h3>Codex</h3>
      </div>
      <div className="pad">
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
      </div>
    </section>
  );
}

// Side panel of the Stages tab: the waiting question, what is happening now, the tool calls, the totals and the timeline.
// Stop run lives in the run header.
export function RunSide({ detail, onChanged }) {
  const { run, timeline = [] } = detail;
  const now = useNow(10000);
  const stageName = (id) => detail.workflow?.nodes?.find((n) => n.id === id)?.name || id; // the stage's name, not its id
  const calls = toolCalls(detail, now);
  return (
    <aside className="run-side" aria-label="Run details">
      {run.status === 'waiting' && <WaitingCard run={run} onDone={onChanged} />}
      <section className="card side-card" aria-label="Status">
        <div className="cardhead">
          <h3>Now</h3>
          <StatusPill status={run.status} />
        </div>
        <div className="pad">
          <p className="muted small now-at">
            {(run.active ?? []).length > 0 ? `At: ${run.active.map((a) => a.name || a.id).join(', ')}` : run.stageName || run.stage} · round {run.round}/{run.maxRounds}
          </p>
          <section aria-label="Active agents">
            <h4 className="sr-only">Active agents</h4>
            <ActiveAgents detail={detail} now={now} />
          </section>
        </div>
      </section>
      {run.provider === 'codex' && <CodexInfo run={run} codex={detail.tokens?.codex} />}
      <section className="card side-card" aria-label="Tool calls">
        <div className="cardhead">
          <h3>Tool calls</h3>
          <span className="faint small">newest first</span>
        </div>
        <div className="pad">
          <ToolCallList calls={calls} agents={detail.agents} />
        </div>
      </section>
      <Totals detail={detail} />
      <section className="card side-card" aria-label="Timeline">
        <div className="cardhead">
          <h3>Timeline</h3>
        </div>
        <div className="pad">
          {timeline.length === 0 && <p className="muted">No events yet.</p>}
          <ol className="timeline">
            {timeline.map((e, i) => (
              <li key={i}>
                <span className="muted"><Ago at={e.at} /></span> <strong>{e.kind}</strong>
                {e.stage && <> {stageName(e.stage)}</>}
                {e.verdict && <> · {e.verdict}</>}
                {e.round > 0 && <> · round {e.round}</>}
                {e.note && <div className="pre">{e.note}</div>}
              </li>
            ))}
          </ol>
        </div>
      </section>
    </aside>
  );
}
