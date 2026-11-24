import { useEffect, useRef, useState } from 'react';
import { Elapsed } from '../Ago.jsx';
import { getAgentActivity } from '../api.js';
import { useNow, useThrottledTick } from '../hooks.js';
import { agentCall, agentLabels, agentName, contextPct, crewTree, modelLabel } from '../lib/crew.js';
import { formatCost } from '../lib/format.js';
import { toolCalls } from '../lib/toolCalls.js';
import { AgentPill, Avatar } from '../RunBits.jsx';
import { WaitingCard } from '../WaitingCards.jsx';
import { ToolCallList, Totals } from './RunSide.jsx';

const MAX_CALLS = 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One agent: who, task, what it is doing now, how full its context is, what it cost. The card is selectable
// (aria-pressed on its name button, also by clicking anywhere on the card) to show that agent's tool calls.
// Wide cards lay the second row out in columns; narrow ones stack it (container query in styles.css).
function AgentCard({ node, view }) {
  const { detail, now, selectedId, onSelect, labels } = view;
  const a = node.agent;
  const label = labels.get(a.id) ?? agentName(a);
  const selected = selectedId === a.id;
  const pct = contextPct(a);
  const call = agentCall(detail, a, now);
  // A click that ends a text selection (copying the task text) does not select the agent.
  const own = (e) => !e.target.closest?.('button, a') && !window.getSelection?.()?.toString();
  const nCalls = Number(a.toolCalls) || 0; // the server's per-agent count (the activity list holds only the last 100 rows)
  return (
    <div className="tn-card">
      <article className={selected ? 'card ag sel' : 'card ag'} data-agent-id={a.id} onClick={(e) => own(e) && onSelect(a.id)}>
        <div className="aghead">
          <Avatar agent={a} />
          <span className="agwho">
            <button type="button" className="ag-hit nm" aria-pressed={selected} onClick={() => onSelect(a.id)}>
              {label}
            </button>
            <span className="md">
              {modelLabel(a.model)}
              {a.provider === 'codex' && <span className="badge codex">Codex</span>}
            </span>
          </span>
          <AgentPill agent={a} />
        </div>
        <div className="agbody">
          {a.description && a.description !== label && <p className="agtask">{a.description}</p>}
          {call && (
            <div className="act">
              <span className="ring" aria-hidden="true" />
              <span className="act-text mono">{call}</span>
            </div>
          )}
          {pct !== null && (
            <div className="ctx">
              <span>Context</span>
              <span className="bar" role="progressbar" aria-label="Context" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                <b style={{ width: `${pct}%` }} />
              </span>
              <span>{pct}%</span>
            </div>
          )}
          <div className="agfoot">
            <span>
              {formatCost(a.tokens?.cost)} · <Elapsed from={a.startedAt} to={a.status === 'running' ? null : a.finishedAt || a.lastActivityAt} />
            </span>
            <span>{node.children.length ? plural(node.children.length, 'helper', 'helpers') : nCalls ? plural(nCalls, 'tool call', 'tool calls') : '–'}</span>
          </div>
        </div>
      </article>
    </div>
  );
}

// A list of nodes, each with its children stacked below it and indented. A child's connector (`data-edge`, drawn in CSS:
// a trunk down the parent's side and an elbow into the child) exists only when its parent is recorded; it is the live
// colour when the child is running. `depth` only caps the indent at narrow widths (styles.css).
function Tree({ nodes, view, depth = 0 }) {
  return (
    <ul className={`tn-list d${Math.min(depth, 4)}`}>
      {nodes.map((n) => (
        <li key={n.id} className="tn-item">
          {n.edge != null && <span className={n.agent.status === 'running' ? 'tn-link live' : 'tn-link'} data-edge={`${n.edge}->${n.id}`} aria-hidden="true" />}
          <AgentCard node={n} view={view} />
          {n.children.length > 0 && <Tree nodes={n.children} view={view} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}

// The Crew tab (contract C7): the agent tree, and a rail with what is happening now, the tool calls and the totals.
export function CrewTab({ detail, onChanged }) {
  const { run } = detail;
  const now = useNow(10000);
  const [picked, setPicked] = useState(null);
  const tree = crewTree(detail.agents);
  const selected = tree.nodes.some((n) => n.id === picked) ? picked : null;

  // The selected agent's own calls come from the server (detail.activity holds only the run's last 100 rows); until
  // they land, or if the fetch fails, the calls found in detail.activity are shown, never an empty list.
  const t = useThrottledTick(`${run.updatedAt}|${detail.activity?.[0]?.id}|${(detail.agents || []).reduce((n, a) => n + (Number(a.toolCalls) || 0), 0)}`, 3000);
  const [fetched, setFetched] = useState(null);
  useEffect(() => {
    if (!selected) return undefined;
    let stale = false;
    getAgentActivity(run.id, selected).then(
      (rows) => !stale && Array.isArray(rows) && setFetched({ agentId: selected, rows }),
      () => {}, // keep what is on screen
    );
    return () => {
      stale = true;
    };
  }, [run.id, selected, t]);
  const own = selected && fetched?.agentId === selected ? fetched.rows : null;
  const calls = !selected
    ? toolCalls(detail, now, MAX_CALLS)
    : own
      ? toolCalls({ ...detail, activity: own }, now, MAX_CALLS)
      : toolCalls(detail, now, Infinity).filter((c) => c.agentId === selected).slice(0, MAX_CALLS);
  const chosen = tree.nodes.find((n) => n.id === selected)?.agent;
  const running = tree.nodes.filter((n) => n.agent.status === 'running').length;
  const total = tree.nodes.length;
  const callsRef = useRef(null);
  // On a phone the rail sits far below the tree, so picking an agent brings its tool calls into view.
  const onSelect = (id) => {
    setPicked((cur) => (cur === id ? null : id));
    if (id !== selected && window.matchMedia?.('(max-width: 768px)').matches) callsRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
  };
  const labels = agentLabels(detail.agents);
  const view = { detail, now, selectedId: selected, onSelect, labels };

  return (
    <div className="run-body crew-body" role="tabpanel" id="panel-crew" aria-labelledby="tab-crew">
      <section className="card crew-main" aria-label="Crew">
        <div className="cardhead">
          <h2>Crew</h2>
          <span className="small muted">
            {plural(total, 'agent', 'agents')} · <span className="live-text">{running} running</span> · <strong className="strong">{formatCost(detail.tokens?.total?.cost)}</strong>
          </span>
        </div>
        {total ? (
          <div className="tree">
            {tree.roots.length > 0 && <Tree nodes={tree.roots} view={view} />}
            {tree.unlinked.length > 0 && (
              <div className="tree-unlinked">
                <h3 className="tree-sub muted small">No recorded parent</h3>
                <Tree nodes={tree.unlinked} view={view} />
              </div>
            )}
          </div>
        ) : (
          <p className="muted pad">No agents yet.</p>
        )}
        <p className="muted small crew-hint">Select an agent to show its own tool calls. A line joins an agent to the one that started it.</p>
      </section>
      <aside className="run-side" aria-label="Run details">
        {run.status === 'waiting' && <WaitingCard run={run} onDone={onChanged} />}
        <section className="card side-card" aria-label="Tool calls" ref={callsRef}>
          <div className="cardhead">
            <h3>Tool calls</h3>
            {chosen ? (
              <button type="button" className="sm" onClick={() => setPicked(null)}>
                Clear filter ({labels.get(chosen.id) ?? agentName(chosen)})
              </button>
            ) : (
              <span className="faint small">newest first</span>
            )}
          </div>
          <div className="pad">
            <ToolCallList calls={calls} agents={detail.agents} hideAgent={!!chosen} empty={chosen ? 'No tool calls from this agent yet.' : 'No tool calls yet.'} />
          </div>
        </section>
        <Totals detail={detail} />
      </aside>
    </div>
  );
}
