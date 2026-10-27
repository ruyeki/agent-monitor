import '@xyflow/react/dist/style.css';
import { Background, Controls, ReactFlow } from '@xyflow/react';
import { useMemo } from 'react';
import { nodeTypes } from '../editor/Canvas.jsx';
import { toFlow } from '../editor/toFlow.js';

const NO_STATS = {};

// The run's pinned graph, read-only: active nodes highlighted, visited nodes marked, visit counts (and tokens when the API has them).
export function RunGraph({ detail }) {
  const { run, workflow } = detail;
  const stats = detail.nodes ?? NO_STATS;
  const graph = useMemo(() => {
    const active = new Set((run.active ?? [{ id: run.stage }]).map((a) => a.id));
    return toFlow(workflow, { runInfo: { active, nodes: stats } });
  }, [workflow, run.active, run.stage, stats]);
  return (
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
        minZoom={0.2}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
