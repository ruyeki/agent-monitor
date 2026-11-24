import '@xyflow/react/dist/style.css';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useEffect, useMemo, useState } from 'react';
import { FIT_VIEW, nodeTypes } from '../editor/Canvas.jsx';
import { toFlow } from '../editor/toFlow.js';
import { StatusIcon } from '../RunList.jsx';
import { runState } from './runState.js';

const LEGEND = [
  ['passed', 'done', 'Passed'],
  ['failed', 'stopped', 'Failed or decision needed'],
  ['waiting', 'waiting', 'Waiting on you'],
  ['running', 'running', 'Running'],
  ['idle', 'idle', 'Not reached / stopped'],
];

const LIVE_STATES = new Set(['running', 'waiting', 'decision']);
const NARROW = '(max-width: 768px)';

function useNarrow() {
  const query = () => !!window.matchMedia?.(NARROW).matches;
  const [narrow, setNarrow] = useState(query);
  useEffect(() => {
    const mq = window.matchMedia?.(NARROW);
    if (!mq?.addEventListener) return undefined;
    const on = () => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

// The run's pinned graph, read-only: each node coloured by its latest visit (see runState.js), with fails, visits and tokens.
// Every gate has a "Stop run" edge to an End node; they are hidden until the legend toggle asks for them, so the edge
// labels at a gate do not pile up. The graph opens framed on the stage the run is at (running or waiting).
export function RunGraph({ detail }) {
  const [showStop, setShowStop] = useState(false);
  const narrow = useNarrow();
  const { graph, activeIds, stopIds } = useMemo(() => {
    const codex = new Set((detail.visits ?? []).filter((v) => v.provider === 'codex').map((v) => v.node));
    const info = runState(detail);
    const wf = detail.workflow;
    const ends = new Set((wf.nodes ?? []).filter((n) => n.type === 'end').map((n) => n.id));
    return {
      graph: toFlow(wf, { runInfo: info, codex }),
      activeIds: Object.keys(info).filter((id) => LIVE_STATES.has(info[id].state)),
      stopIds: new Set((wf.edges ?? []).filter((e) => ends.has(e.to) && /^stop/i.test(e.on)).map((e) => e.id)),
    };
  }, [detail]);
  const edges = showStop ? graph.edges : graph.edges.filter((e) => !stopIds.has(e.id));
  const fit = activeIds.length ? { ...FIT_VIEW, nodes: activeIds.map((id) => ({ id })), padding: 0.5, maxZoom: 1 } : FIT_VIEW;
  return (
    <div className="card run-graph-wrap">
      <div className="cardhead">
        <h2>Stages</h2>
        <div className="run-legend" role="group" aria-label="Colour legend">
          {LEGEND.map(([state, icon, label]) => (
            <span key={state} className={`legend-item run-${state}`}>
              <StatusIcon status={icon} size={12} decorative /> {label}
            </span>
          ))}
          {stopIds.size > 0 && (
            <button type="button" className="sm ghost" aria-pressed={showStop} onClick={() => setShowStop((v) => !v)}>
              Show stop edges
            </button>
          )}
        </div>
      </div>
      <div className="canvas run-graph" role="group" aria-label="Run graph">
      <ReactFlow
        nodes={graph.nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={fit}
        minZoom={0.2}
        panOnDrag={!narrow}
        preventScrolling={!narrow}
      >
        <Background />
        <Controls showInteractive={false} fitViewOptions={{ padding: 0.1, minZoom: 0.3 }} position={narrow ? 'top-right' : 'bottom-left'} />
      </ReactFlow>
      </div>
    </div>
  );
}
