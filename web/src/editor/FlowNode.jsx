import { Handle, Position } from '@xyflow/react';
import { formatTokens } from '../lib/format.js';
import { typeName } from './model.js';

const ICONS = {
  step: <path d="M3 4h10M3 8h10M3 12h6" />,
  check: (
    <>
      <circle cx="8" cy="8" r="6" />
      <path d="M5 8l2 2 4-4" />
    </>
  ),
  gate: <path d="M6 3v10M10 3v10" />,
  split: <path d="M8 2v4M8 6L4 10v4M8 6l4 4v4" />,
  join: <path d="M4 2v4l4 4v4M12 2v4l-4 4" />,
  end: (
    <>
      <circle cx="8" cy="8" r="6" />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </>
  ),
};

// The icon of a node type, shared by the cards and the palette.
export function TypeIcon({ type, className }) {
  return (
    <svg className={className} viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[type]}
    </svg>
  );
}

// One node card, shared by the editor and the run view. data.stats = editor stats line; data.run = run state (see run/runState.js).
export function FlowNode({ data, selected }) {
  const n = data.node;
  const run = data.run;
  const cls = ['fnode', `type-${n.type}`];
  if (run) cls.push(`run-${run.state}`);
  if (selected) cls.push('selected');
  if (data.error) cls.push('has-error');
  const sub = n.type === 'step' || n.type === 'check' ? `${n.runner} · ${n.model}` : null;
  return (
    <div className={cls.join(' ')} data-node={n.id} data-state={run?.state}>
      <Handle type="target" position={Position.Top} isConnectable={!run} />
      <div className="fnode-head">
        <TypeIcon type={n.type} className="fnode-icon" />
        <strong className="fnode-name">{n.name || n.id}</strong>
      </div>
      <div className="fnode-row">
        <span className="badge fnode-type">{typeName(n.type)}</span>
        {sub && <span className="muted fnode-sub">{sub}</span>}
        {n.pushes && <span className="badge pushes">pushes</span>}
      </div>
      {data.stats && <div className="muted fnode-stats">{data.stats}</div>}
      {run && (
        <div className="fnode-row">
          {run.status && <span className="fnode-status">{run.status}</span>}
          {run.fails > 0 && <span className="badge fails">{run.fails} {run.fails === 1 ? 'fail' : 'fails'}</span>}
          {run.tokens != null && <span className="badge">{formatTokens(run.tokens)} tokens</span>}
          {run?.codex && <span className="badge codex">Codex</span>}
          {run.visits > 0 && <span className="badge visits">{run.visits} {run.visits === 1 ? 'visit' : 'visits'}</span>}
        </div>
      )}
      {n.type !== 'end' && <Handle type="source" position={Position.Bottom} isConnectable={!run} />}
    </div>
  );
}
