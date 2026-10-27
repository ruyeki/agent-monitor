import { Handle, Position } from '@xyflow/react';
import { formatTokens } from '../lib/format.js';
import { typeName } from './model.js';

// One node of the graph, in the editor and (with data.run) in the run view.
export function FlowNode({ data, selected }) {
  const n = data.node;
  const run = data.run;
  const cls = ['fnode', `type-${n.type}`];
  if (selected) cls.push('selected');
  if (data.error) cls.push('has-error');
  if (run?.active) cls.push('active');
  else if (run?.visits > 0) cls.push('visited');
  const sub = n.type === 'step' || n.type === 'check' ? `${n.runner} / ${n.model}` : null;
  return (
    <div className={cls.join(' ')} data-node={n.id}>
      <Handle type="target" position={Position.Left} isConnectable={!run} />
      <strong className="fnode-name">{n.name || n.id}</strong>
      <span className="muted fnode-sub">
        {typeName(n.type)}
        {sub && ` · ${sub}`}
      </span>
      <span className="fnode-badges">
        {n.pushes && <span className="badge">pushes</span>}
        {run?.active && <span className="badge here">active</span>}
        {run?.visits > 0 && <span className="badge visits">{run.visits} {run.visits === 1 ? 'visit' : 'visits'}</span>}
        {run?.tokens != null && <span className="badge">{formatTokens(run.tokens)} tokens</span>}
      </span>
      {n.type !== 'end' && <Handle type="source" position={Position.Right} isConnectable={!run} />}
    </div>
  );
}
