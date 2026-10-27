import { NODE_TYPES, typeName } from './model.js';

export const DRAG_TYPE = 'application/x-agent-monitor-node';

const HINT = {
  step: 'An agent does some work',
  check: 'An agent checks the work: pass or fail',
  gate: 'Waits for Ryan to answer',
  split: 'Starts parallel branches',
  join: 'Waits for every branch',
  end: 'Ends the run',
};

// Drag an item onto the canvas (or press it) to add a node of that type.
export function Palette({ onAdd }) {
  return (
    <aside className="palette" aria-label="Node palette">
      <h2>Palette</h2>
      <p className="muted">Drag onto the canvas, or press to add.</p>
      <ul>
        {NODE_TYPES.map((t) => (
          <li key={t}>
            <button
              type="button"
              className={`palette-item type-${t}`}
              draggable
              title={HINT[t]}
              onDragStart={(e) => {
                e.dataTransfer.setData(DRAG_TYPE, t);
                e.dataTransfer.effectAllowed = 'move';
              }}
              onClick={() => onAdd(t)}
            >
              {typeName(t)}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
