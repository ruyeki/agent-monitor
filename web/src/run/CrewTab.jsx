import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Elapsed } from '../Ago.jsx';
import { barSpan } from '../lib/connectors.js';
import { agentCall, agentName, contextPct, crewTree, modelLabel } from '../lib/crew.js';
import { formatCost, formatTokens } from '../lib/format.js';
import { pillLabel, toolCalls } from '../lib/toolCalls.js';
import { stageLabel } from '../RunList.jsx';
import { AgentPill, Avatar, StatusPill } from '../RunBits.jsx';
import { WaitingCard } from '../WaitingCards.jsx';
import { ThinkingLoader } from '../vendor/affectui/thinking-loader.tsx';
import { ToolCallList, useNow } from './RunSide.jsx';

const MAX_CALLS = 10;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// One agent: who, task, what it is doing now, how full its context is, what it cost. The card is selectable
// (aria-pressed on its name button, also by clicking anywhere on the card) to filter the tool calls.
function AgentCard({ node, view }) {
  const { detail, now, selectedId, onSelect, counts } = view;
  const a = node.agent;
  const selected = selectedId === a.id;
  const pct = contextPct(a);
  const call = agentCall(detail, a, now);
  const own = (e) => !e.target.closest?.('button, a');
  const nCalls = counts.get(a.id) ?? 0;
  return (
    <article className={selected ? 'card ag sel' : 'card ag'} data-agent-id={a.id} onClick={(e) => own(e) && onSelect(a.id)}>
      <div className="aghead">
        <Avatar agent={a} />
        <span className="agwho">
          <button type="button" className="ag-hit nm" aria-pressed={selected} onClick={() => onSelect(a.id)}>
            {agentName(a)}
          </button>
          <span className="md">
            {modelLabel(a.model)}
            {a.provider === 'codex' && <span className="badge codex">Codex</span>}
          </span>
        </span>
        <AgentPill agent={a} />
      </div>
      {a.description && <p className="agtask">{a.description}</p>}
      {call && (
        <div className="act">
          <span className="ring" aria-hidden="true" />
          <span className="act-text mono">{call}</span>
        </div>
      )}
      {pct !== null && (
        <div className="ctx">
          <span>Context</span>
          <span className="bar" role="progressbar" aria-label="Context" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
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
    </article>
  );
}

// The children of a node (or the roots), side by side. A child with a recorded parent gets a stub (`data-edge`); one
// bar from the parent's centre to the farthest such child joins the parent's stub to them. A child without a recorded
// parent gets no stub and lies outside the bar. Positions are measured, because they depend on the cards' widths.
function Kids({ nodes, view, roots }) {
  const ref = useRef(null);
  const [span, setSpan] = useState(null);
  const hasLinked = nodes.some((n) => n.edge != null);
  const measure = () => {
    const el = ref.current;
    if (roots || !el || !hasLinked) return setSpan(null);
    const box = el.getBoundingClientRect();
    const kids = [...el.querySelectorAll(':scope > .tn-kid')].map((k, i) => {
      const r = k.getBoundingClientRect();
      return { x: r.left - box.left + r.width / 2, linked: nodes[i]?.edge != null };
    });
    const next = barSpan(box.width / 2, kids);
    setSpan((cur) => (cur && next && cur.left === next.left && cur.right === next.right ? cur : next));
  };
  useLayoutEffect(measure); // after every render: cards change height and width as their text changes
  useEffect(() => {
    const el = ref.current;
    if (!el || roots || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  });
  return (
    <div ref={ref} className={roots ? 'tn-kids tn-roots' : 'tn-kids'}>
      {!roots && hasLinked && <span className="tn-bar" data-bar="" aria-hidden="true" style={span ? { left: span.left, width: span.right - span.left } : { display: 'none' }} />}
      {nodes.map((n) => (
        <div key={n.id} className="tn-kid">
          {n.edge != null && <span className="edge" data-edge={`${n.edge}->${n.id}`} aria-hidden="true" />}
          <div className="tn">
            <AgentCard node={n} view={view} />
            {n.children.length > 0 && <Kids nodes={n.children} view={view} />}
          </div>
        </div>
      ))}
    </div>
  );
}

function NowCard({ detail, now }) {
  const { run, agents = [] } = detail;
  const running = agents.filter((a) => a.status === 'running');
  return (
    <section className="card side-card" aria-label="Now">
      <div className="cardhead">
        <h3>Now</h3>
        <StatusPill status={run.status} />
      </div>
      <div className="pad">
        {running.length ? (
          <ul className="now-list">
            {running.map((a) => {
              const label = pillLabel(detail, a, now, stageLabel(run));
              const call = agentCall(detail, a, now);
              return (
                <li key={a.id} className="now-item">
                  <span className="now-who">
                    <Avatar agent={a} />
                    <strong>{agentName(a)}</strong>
                  </span>
                  {call && <span className="mono muted small now-call">{call}</span>}
                  {label && <ThinkingLoader size="sm" phases={[label]} />}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="muted">No agent is running.</p>
        )}
      </div>
    </section>
  );
}

function Totals({ detail }) {
  const t = detail.tokens?.total || {};
  return (
    <section className="card side-card" aria-label="Totals">
      <div className="cardhead">
        <h3>Totals</h3>
        <span className="muted small">API-equivalent estimate</span>
      </div>
      <div className="pad totals-grid">
        <div>
          <div className="muted small">Tokens</div>
          <strong className="big">{formatTokens(t.total)}</strong>
        </div>
        <div>
          <div className="muted small">Cost</div>
          <strong className="big">{formatCost(t.cost)}</strong>
        </div>
        <p className="muted small totals-split">
          Input {formatTokens(t.input)} · Output {formatTokens(t.output)} · Cache write {formatTokens(t.cacheWrite)} · Cache read {formatTokens(t.cacheRead)}
        </p>
      </div>
    </section>
  );
}

// The Crew tab (contract C7): the agent tree, and a rail with what is happening now, the tool calls and the totals.
export function CrewTab({ detail, onChanged }) {
  const { run } = detail;
  const now = useNow(10000);
  const [picked, setPicked] = useState(null);
  const tree = crewTree(detail.agents);
  const selected = tree.nodes.some((n) => n.id === picked) ? picked : null;
  useEffect(() => {
    if (picked && !selected) setPicked(null); // the agent left the run: stop filtering by it
  }, [picked, selected]);

  const all = toolCalls(detail, now, Infinity);
  const counts = new Map();
  for (const c of all) counts.set(c.agentId, (counts.get(c.agentId) ?? 0) + 1);
  const calls = (selected ? all.filter((c) => c.agentId === selected) : all).slice(0, MAX_CALLS);
  const chosen = tree.nodes.find((n) => n.id === selected)?.agent;
  const running = tree.nodes.filter((n) => n.agent.status === 'running').length;
  const total = tree.nodes.length;
  const view = { detail, now, selectedId: selected, counts, onSelect: (id) => setPicked((cur) => (cur === id ? null : id)) };

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
          <div className="tree-scroll">
            <div className="tree">
              <Kids nodes={tree.roots} view={view} roots />
            </div>
          </div>
        ) : (
          <p className="muted pad">No agents yet.</p>
        )}
        <p className="muted small crew-hint">Select an agent to show only its tool calls. A line joins an agent to the one that started it; an agent without a line has no recorded parent.</p>
      </section>
      <aside className="run-side" aria-label="Run details">
        {run.status === 'waiting' && <WaitingCard run={run} onDone={onChanged} />}
        <NowCard detail={detail} now={now} />
        <section className="card side-card" aria-label="Tool calls">
          <div className="cardhead">
            <h3>Tool calls</h3>
            {chosen ? (
              <button type="button" className="sm" onClick={() => setPicked(null)}>
                Clear filter ({agentName(chosen)})
              </button>
            ) : (
              <span className="faint small">newest first</span>
            )}
          </div>
          <div className="pad">
            <ToolCallList calls={calls} empty={chosen ? 'No tool calls from this agent yet.' : 'No tool calls yet.'} />
          </div>
        </section>
        <Totals detail={detail} />
      </aside>
    </div>
  );
}
