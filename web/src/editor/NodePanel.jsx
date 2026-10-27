import { useEffect, useState } from 'react';
import { Field, Options } from './fields.jsx';
import { addAction, idProblem, MODELS, NODE_TYPES, patchNode, removeAction, renameAction, RUNNERS, setNodeType } from './model.js';

function IdField({ wf, node, onRename }) {
  const [text, setText] = useState(node.id);
  const [problem, setProblem] = useState(null);
  useEffect(() => {
    setText(node.id);
    setProblem(null);
  }, [node.id]);
  const commit = () => {
    if (text === node.id) return setProblem(null);
    const p = idProblem(wf, node.id, text);
    setProblem(p);
    if (!p) onRename(node.id, text);
  };
  return (
    <>
      <Field label="Id">
        <input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} />
      </Field>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
    </>
  );
}

function ActionsEditor({ wf, node, edit }) {
  const actions = node.actions ?? [];
  return (
    <fieldset className="actions-editor">
      <legend>Actions</legend>
      {actions.map((a, i) => (
        <div key={i} className="action-row">
          <input aria-label={`Action ${i + 1} label`} value={a.label} onChange={(e) => edit(renameAction(wf, node.id, i, e.target.value))} />
          <button type="button" aria-label={`Remove action ${i + 1}`} onClick={() => edit(removeAction(wf, node.id, i))}>
            Remove
          </button>
        </div>
      ))}
      <button type="button" onClick={() => edit(addAction(wf, node.id))}>
        Add action
      </button>
    </fieldset>
  );
}

// Every field of the selected node.
export function NodePanel({ wf, node, edit, onRename, onDelete }) {
  const patch = (p) => edit(patchNode(wf, node.id, p));
  const text = (key) => ({ value: node[key] ?? '', onChange: (e) => patch({ [key]: e.target.value }) });
  return (
    <section aria-label={`Node ${node.id}`}>
      <h3>Node settings</h3>
      <IdField wf={wf} node={node} onRename={onRename} />
      <Field label="Name">
        <input {...text('name')} />
      </Field>
      <Field label="Type">
        <select value={node.type} onChange={(e) => edit(setNodeType(wf, node.id, e.target.value))}>
          <Options values={NODE_TYPES} current={node.type} />
        </select>
      </Field>
      <Field label="Runner">
        <select {...text('runner')}>
          <Options values={RUNNERS} current={node.runner} />
        </select>
      </Field>
      <Field label="Model">
        <select {...text('model')}>
          <Options values={MODELS} current={node.model} />
        </select>
      </Field>
      <Field label="Instructions">
        <textarea rows={6} {...text('instructions')} />
      </Field>
      {node.type === 'gate' && (
        <>
          <Field label="Ask">
            <textarea rows={2} {...text('ask')} />
          </Field>
          <label className="check-row">
            <input type="checkbox" checked={!!node.textField} onChange={(e) => patch({ textField: e.target.checked })} /> Allow a text reply
          </label>
          <ActionsEditor wf={wf} node={node} edit={edit} />
        </>
      )}
      <label className="check-row">
        <input type="checkbox" checked={!!node.pushes} onChange={(e) => patch({ pushes: e.target.checked })} /> Pushes to the remote
      </label>
      <button type="button" className="danger" onClick={onDelete}>
        Delete node
      </button>
    </section>
  );
}
