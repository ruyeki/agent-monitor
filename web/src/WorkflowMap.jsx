import { buildMap } from './lib/map.js';

function Node({ n, col, row }) {
  const cls = ['node', `kind-${n.kind}`, n.current && 'current', n.visited && 'visited'].filter(Boolean).join(' ');
  return (
    <div className={cls} style={{ gridColumn: col, gridRow: row }} aria-current={n.current ? 'step' : undefined} data-stage={n.id}>
      <span className="node-name">{n.name}</span>
      {n.visited && <span className="tick">✓ visited</span>}
      {n.current && <span className="here">current</span>}
    </div>
  );
}

export function WorkflowMap({ workflow, run, timeline }) {
  const m = buildMap(workflow, run, timeline);
  const sideRow = m.lanes.length + 1;
  return (
    <div className="map-wrap">
      <p className="muted">
        Status <strong>{m.status}</strong> · round {m.round}/{m.maxRounds}
      </p>
      <div className="map" style={{ gridTemplateColumns: `5rem repeat(${m.columns.length}, minmax(6.5rem, 1fr))` }}>
        {m.lanes.map((l, i) => (
          <div key={l} className="lane-label" style={{ gridColumn: 1, gridRow: i + 1 }}>
            {l}
          </div>
        ))}
        <div className="lane-label" style={{ gridColumn: 1, gridRow: sideRow }}>
          loop
        </div>
        {m.columns.map((c, i) => (
          <Node key={c.id} n={c} col={i + 2} row={c.lane ? m.lanes.indexOf(c.lane) + 1 : `1 / ${sideRow}`} />
        ))}
        {m.side.map((n, i) => (
          <Node key={n.id} n={n} col={i + 3} row={sideRow} />
        ))}
      </div>
    </div>
  );
}
