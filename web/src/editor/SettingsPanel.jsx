import { Field, Options } from './fields.jsx';
import { NodePanel } from './NodePanel.jsx';
import { onChoices, patchEdge } from './model.js';

function EdgePanel({ wf, edge, edit, onDelete }) {
  const source = wf.nodes.find((n) => n.id === edge.from);
  return (
    <section aria-label={`Edge ${edge.id}`}>
      <h3>Edge settings</h3>
      <p className="muted">
        {edge.from} to {edge.to}
      </p>
      <Field label="On">
        <select value={edge.on} onChange={(e) => edit(patchEdge(wf, edge.id, { on: e.target.value }))}>
          <Options values={onChoices(source)} current={edge.on} />
        </select>
      </Field>
      <label className="check-row">
        <input type="checkbox" checked={!!edge.fixRound} onChange={(e) => edit(patchEdge(wf, edge.id, { fixRound: e.target.checked }))} /> Fix round
      </label>
      <button type="button" className="danger" onClick={onDelete}>
        Delete edge
      </button>
    </section>
  );
}

function LoopPanel({ wf, edit }) {
  const loop = wf.loop ?? {};
  const set = (p) => edit({ ...wf, loop: { ...loop, ...p } });
  const gates = wf.nodes.filter((n) => n.type === 'gate').map((n) => n.id);
  return (
    <section aria-label="Loop settings">
      <h3>Loop settings</h3>
      <Field label="Max rounds (1-10)">
        <input
          type="number"
          min={1}
          max={10}
          value={loop.maxRounds ?? ''}
          onChange={(e) => set({ maxRounds: e.target.value === '' ? '' : Number(e.target.value) })}
        />
      </Field>
      <Field label="Decision gate">
        <select value={loop.decision ?? ''} onChange={(e) => set({ decision: e.target.value })}>
          <Options values={gates} current={loop.decision} />
        </select>
      </Field>
      <p className="muted">Fix-round edges count toward the round limit; past it the run goes to the decision gate.</p>
    </section>
  );
}

function Outline({ wf, onSelect }) {
  return (
    <nav aria-label="Outline">
      <h4>Nodes</h4>
      <ul className="outline">
        {wf.nodes.map((n) => (
          <li key={n.id}>
            <button type="button" onClick={() => onSelect({ kind: 'node', id: n.id })}>
              {n.name || n.id}
            </button>
          </li>
        ))}
      </ul>
      <h4>Edges</h4>
      <ul className="outline">
        {wf.edges.map((e) => (
          <li key={e.id}>
            <button type="button" onClick={() => onSelect({ kind: 'edge', id: e.id })}>
              {e.from} -{e.on}-&gt; {e.to}
            </button>
          </li>
        ))}
      </ul>
    </nav>
  );
}

// Right-hand panel: the selected node or edge, or the loop settings when nothing is selected.
export function SettingsPanel({ wf, selected, edit, onSelect, onRename, onDeleteSelected }) {
  const node = selected?.kind === 'node' ? wf.nodes.find((n) => n.id === selected.id) : null;
  const edge = selected?.kind === 'edge' ? wf.edges.find((e) => e.id === selected.id) : null;
  return (
    <aside className="settings" aria-label="Settings">
      {node && <NodePanel key={node.id} wf={wf} node={node} edit={edit} onRename={onRename} onDelete={onDeleteSelected} />}
      {edge && <EdgePanel key={edge.id} wf={wf} edge={edge} edit={edit} onDelete={onDeleteSelected} />}
      {!node && !edge && (
        <>
          <LoopPanel wf={wf} edit={edit} />
          <Outline wf={wf} onSelect={onSelect} />
        </>
      )}
    </aside>
  );
}
