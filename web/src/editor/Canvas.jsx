import { Background, Controls, ReactFlow, useNodesState } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { FlowNode } from './FlowNode.jsx';
import { DRAG_TYPE } from './Palette.jsx';
import { toFlow } from './toFlow.js';

export const nodeTypes = { wf: FlowNode };

// Fit-to-view for both canvases. Names are 16 px (.fnode-name), so a minZoom of 12/16 keeps them at 12 px or more
// at fit-to-view whatever the graph size: a long graph is centred and panned, not shrunk.
export const FIT_VIEW = { padding: 0.1, minZoom: 0.75 };

// The full-page graph: select, drag, connect, and receive palette drops. Edits go up through the callbacks.
export function Canvas({ wf, selected, errors, stats, onSelect, onConnect, onMove, onDropType }) {
  const graph = useMemo(() => toFlow(wf, { selected, errors, stats }), [wf, selected, errors, stats]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => setNodes((old) => graph.nodes.map((n) => { const m = old.find((o) => o.id === n.id)?.measured; return m ? { ...n, measured: m } : n; })), [graph.nodes, setNodes]);

  const onDragOver = (e) => {
    if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (e) => {
    const type = e.dataTransfer.getData(DRAG_TYPE);
    if (!type) return;
    e.preventDefault();
    onDropType(type, { x: e.clientX, y: e.clientY });
  };

  return (
    <div className="canvas" role="group" aria-label="Workflow canvas" onDragOver={onDragOver} onDrop={onDrop}>
      <ReactFlow
        nodes={nodes}
        edges={graph.edges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={(_e, n) => onSelect({ kind: 'node', id: n.id })}
        onEdgeClick={(_e, ed) => onSelect({ kind: 'edge', id: ed.id })}
        onPaneClick={() => onSelect(null)}
        onNodeDragStop={(_e, n) => onMove(n.id, n.position)}
        onConnect={(c) => onConnect(c.source, c.target)}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW}
        minZoom={0.2}
      >
        <Background />
        <Controls showInteractive={false} fitViewOptions={FIT_VIEW} />
      </ReactFlow>
    </div>
  );
}
