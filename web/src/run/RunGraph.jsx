import '@xyflow/react/dist/style.css';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { FIT_VIEW, nodeTypes } from '../editor/Canvas.jsx';
import { toFlow } from '../editor/toFlow.js';
import { runState } from './runState.js';

const LEGEND = [
  ['passed', '✓', 'Passed'],
  ['failed', '✕', 'Failed or decision needed'],
  ['waiting', '⏸', 'Waiting on Ryan'],
  ['running', '▶', 'Running'],
  ['idle', '–', 'Not reached / stopped'],
];

// The run's pinned graph, read-only: each node coloured by its latest visit (see runState.js), with fails, visits and tokens.
export function RunGraph({ detail }) {
  const graph = useMemo(() => {
    const codex = new Set((detail.visits ?? []).filter((v) => v.provider === 'codex').map((v) => v.node));
    return toFlow(detail.workflow, { runInfo: runState(detail), codex });
  }, [detail]);
  return (
    <div className="run-graph-wrap">
      <div className="run-legend" role="group" aria-label="Colour legend">
        {LEGEND.map(([state, glyph, label]) => (
          <span key={state} className={`legend-item run-${state}`}>
            <span aria-hidden="true">{glyph}</span> {label}
          </span>
        ))}
      </div>
      <div className="canvas run-graph" role="group" aria-label="Run graph">
      <ReactFlow
        nodes={graph.nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
      >
        <Background />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
      </ReactFlow>
      </div>
    </div>
  );
}
