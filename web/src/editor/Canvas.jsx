import { Background, Controls, ReactFlow, useNodesState } from '@xyflow/react';
import { useEffect, useMemo } from 'react';
import { FlowNode } from './FlowNode.jsx';
import { DRAG_TYPE } from './Palette.jsx';
import { toFlow } from './toFlow.js';

export const nodeTypes = { wf: FlowNode };

// The full-page graph: select, drag, connect, and receive palette drops. Edits go up through the callbacks.
export function Canvas({ wf, selected, errors, onSelect, onConnect, onMove, onDropType }) {
  const graph = useMemo(() => toFlow(wf, { selected, errors }), [wf, selected, errors]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => setNodes(graph.nodes), [graph.nodes, setNodes]);

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
        minZoom={0.2}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
