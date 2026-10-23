import { Handle, Position } from '@xyflow/react';

export function StageNode({ data }) {
  const s = data.stage;
  return (
    <div className={`fnode kind-${s.kind}${data.selected ? ' selected' : ''}`} data-stage={s.id}>
      <Handle type="target" position={Position.Left} />
      <strong className="fnode-name">{s.name || s.id}</strong>
      <span className="muted fnode-sub">{s.kind === 'gate' ? 'gate: ask' : `${s.runner} / ${s.model}`}</span>
      <span className="fnode-badges">
        {s.check && <span className="badge">check: {s.check.onFail}</span>}
        {s.pushes && <span className="badge">pushes</span>}
      </span>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

export function SyntheticNode({ data }) {
  return (
    <div className={`fnode synthetic synthetic-${data.label.toLowerCase()}`}>
      <Handle type="target" position={Position.Left} />
      {data.label}
      <Handle type="source" position={Position.Right} />
    </div>
  );
}
