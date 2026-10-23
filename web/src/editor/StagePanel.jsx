import { useState } from 'react';
import { moveStage } from '../lib/reorder.js';
import { CHECKS, MODELS, RUNNERS, idProblem, patchStage, setKind } from './model.js';

function Field({ label, children }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

function Select({ label, ariaLabel, value, options, onChange }) {
  const opts = options.includes(value) ? options : [value, ...options];
  const select = (
    <select aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>
      {opts.map((o) => (
        <option key={o} value={o}>
          {o}
        </option>
      ))}
    </select>
  );
  return ariaLabel ? select : <Field label={label}>{select}</Field>;
}

// The id is edited as local text; the rename (and every reference to it) is applied on blur or Enter, only when valid.
function IdField({ wf, id, onRename }) {
  const [text, setText] = useState(id);
  const [problem, setProblem] = useState(null);
  const apply = () => {
    if (text === id) return setProblem(null);
    const p = idProblem(wf, id, text);
    setProblem(p);
    if (!p) onRename(id, text);
  };
  return (
    <>
      <Field label="Id">
        <input
          value={text}
          aria-invalid={problem ? 'true' : undefined}
          onChange={(e) => setText(e.target.value)}
          onBlur={apply}
          onKeyDown={(e) => e.key === 'Enter' && apply()}
        />
      </Field>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

function Text({ label, value, onChange, area }) {
  const Tag = area ? 'textarea' : 'input';
  return (
    <Field label={label}>
      <Tag value={value ?? ''} rows={area ? 5 : undefined} onChange={(e) => onChange(e.target.value)} />
    </Field>
  );
}

export function LoopPanel({ wf, edit }) {
  const loop = wf.loop ?? {};
  const set = (patch) => edit({ ...wf, loop: { ...loop, ...patch } });
  const ids = wf.stages.map((s) => s.id);
  return (
    <section aria-label="Loop settings">
      <h3>Loop settings</h3>
      <Field label="Max rounds">
        <input type="number" min="1" max="10" value={loop.maxRounds ?? ''} onChange={(e) => set({ maxRounds: e.target.value === '' ? null : Number(e.target.value) })} />
      </Field>
      <Select label="Fix runner" value={loop.fixRunner ?? 'worker'} options={RUNNERS} onChange={(v) => set({ fixRunner: v })} />
      <Select label="Fix model" value={loop.fixModel ?? 'inherit'} options={MODELS} onChange={(v) => set({ fixModel: v })} />
      <Select label="After fix, go to" value={loop.afterFix ?? ''} options={ids} onChange={(v) => set({ afterFix: v })} />
      <Select label="Resume at" value={loop.resumeAt ?? ''} options={ids} onChange={(v) => set({ resumeAt: v })} />
    </section>
  );
}

export function StagePanel({ wf, stage, edit, onRename, onDelete }) {
  const idx = wf.stages.findIndex((s) => s.id === stage.id);
  const patch = (p) => edit(patchStage(wf, stage.id, p));
  const gotos = ['next', 'stop', ...wf.stages.map((s) => s.id)];
  const setAction = (i, p) => patch({ actions: stage.actions.map((a, j) => (j === i ? { ...a, ...p } : a)) });
  return (
    <section aria-label="Stage settings">
      <h3>Stage: {stage.name || stage.id}</h3>
      <div className="actions">
        <button type="button" disabled={idx <= 0} onClick={() => edit({ ...wf, stages: moveStage(wf.stages, stage.id, idx - 1) })}>
          Move left
        </button>
        <button type="button" disabled={idx >= wf.stages.length - 1} onClick={() => edit({ ...wf, stages: moveStage(wf.stages, stage.id, idx + 1) })}>
          Move right
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete stage
        </button>
      </div>
      <IdField key={stage.id} wf={wf} id={stage.id} onRename={onRename} />
      <Text label="Name" value={stage.name} onChange={(v) => patch({ name: v })} />
      <Select label="Kind" value={stage.kind} options={['step', 'gate']} onChange={(v) => edit(setKind(wf, stage.id, v))} />
      <Select label="Runner" value={stage.runner} options={RUNNERS} onChange={(v) => patch({ runner: v })} />
      <Select label="Model" value={stage.model} options={MODELS} onChange={(v) => patch({ model: v })} />
      <Text label="Instructions" area value={stage.instructions} onChange={(v) => patch({ instructions: v })} />
      <Select label="Check" value={stage.check?.onFail ?? 'none'} options={CHECKS} onChange={(v) => patch({ check: v === 'none' ? null : { onFail: v } })} />
      <label className="check-row">
        <input type="checkbox" checked={!!stage.pushes} onChange={(e) => patch({ pushes: e.target.checked })} /> Pushes
      </label>
      {stage.kind === 'gate' && (
        <>
          <Text label="Ask" area value={stage.ask} onChange={(v) => patch({ ask: v })} />
          <label className="check-row">
            <input type="checkbox" checked={!!stage.textField} onChange={(e) => patch({ textField: e.target.checked })} /> Text field
          </label>
          <h4>Actions</h4>
          {(stage.actions ?? []).map((a, i) => (
            <div key={i} className="action-row">
              <input aria-label={`Action ${i + 1} label`} value={a.label} onChange={(e) => setAction(i, { label: e.target.value })} />
              <Select ariaLabel={`Action ${i + 1} goto`} value={a.goto} options={gotos} onChange={(v) => setAction(i, { goto: v })} />
              <button type="button" aria-label={`Remove action ${i + 1}`} onClick={() => patch({ actions: stage.actions.filter((_, j) => j !== i) })}>
                Remove
              </button>
            </div>
          ))}
          <button type="button" onClick={() => patch({ actions: [...(stage.actions ?? []), { label: 'Action', goto: 'next' }] })}>
            Add action
          </button>
        </>
      )}
    </section>
  );
}
