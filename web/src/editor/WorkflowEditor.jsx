import '@xyflow/react/dist/style.css';
import { ReactFlowProvider, useReactFlow } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { autoLayout } from '../lib/layout.js';
import { Canvas } from './Canvas.jsx';
import { ErrorList } from './ErrorList.jsx';
import { addNode, connect, patchNode, removeEdge, removeNode, renameNode } from './model.js';
import { Palette } from './Palette.jsx';
import { SettingsPanel } from './SettingsPanel.jsx';
import { errorTargets } from './toFlow.js';
import { TopBar } from './TopBar.jsx';
import { useDraft } from './useDraft.js';

const isEditable = (el) =>
  !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'].includes(el.tagName) || !!el.closest?.('[role=alertdialog], [role=dialog]'));

function EditorBody({ tick }) {
  const draft = useDraft(tick);
  const { wf, edit } = draft;
  const rf = useReactFlow();
  const canvasBox = useRef(null);
  const [selected, setSelected] = useState(null); // {kind: 'node'|'edge', id}
  const [confirm, setConfirm] = useState(null); // {what: 'discard'} | {what: 'load', version}
  const errors = useMemo(() => errorTargets(draft.publishErrors), [draft.publishErrors]);

  const deleteSelected = useCallback(() => {
    if (!selected || !wf) return;
    edit(selected.kind === 'node' ? removeNode(wf, selected.id) : removeEdge(wf, selected.id));
    setSelected(null);
  }, [selected, wf, edit]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.key === 'Delete' || e.key === 'Backspace') && !isEditable(e.target)) deleteSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [deleteSelected]);

  if (!wf) {
    return draft.problem ? (
      <p className="error" role="alert">
        {draft.problem}
      </p>
    ) : (
      <p className="muted pad">Loading workflow…</p>
    );
  }

  const addAt = (type, client) => {
    const next = addNode(wf, type, rf.screenToFlowPosition(client));
    edit(next);
    setSelected({ kind: 'node', id: next.nodes.at(-1).id });
  };
  const addAtCenter = (type) => {
    const r = canvasBox.current.getBoundingClientRect();
    addAt(type, { x: r.left + r.width / 2, y: r.top + r.height / 2 });
  };
  const onConnect = (from, to) => {
    const next = connect(wf, from, to);
    if (next === wf) return;
    edit(next);
    setSelected({ kind: 'edge', id: next.edges.at(-1).id });
  };
  const onRename = (from, to) => {
    edit(renameNode(wf, from, to));
    setSelected({ kind: 'node', id: to });
  };
  const askLoad = (version) => (draft.hasChanges ? setConfirm({ what: 'load', version }) : draft.replaceDraft(version));
  const runConfirm = () => {
    const c = confirm;
    setConfirm(null);
    setSelected(null);
    draft.replaceDraft(c.what === 'load' ? c.version : null);
  };

  return (
    <div className="editor">
      <TopBar
        published={draft.published}
        status={draft.status}
        versions={draft.versions}
        onPublish={draft.publish}
        onDiscard={() => setConfirm({ what: 'discard' })}
        onLoadVersion={askLoad}
        onLayout={() => edit(autoLayout(wf))}
      />
      {draft.problem && (
        <p className="error pad" role="alert">
          {draft.problem}
        </p>
      )}
      {draft.publishErrors && <ErrorList errors={draft.publishErrors} onSelect={setSelected} />}
      {confirm && (
        <div className="confirm" role="alertdialog" aria-label="Confirm">
          <span>
            {confirm.what === 'discard'
              ? 'Discard the draft and go back to the published workflow?'
              : `Replace the draft with version ${confirm.version}? Your draft changes will be lost.`}
          </span>
          <button type="button" className="danger" onClick={runConfirm}>
            Confirm
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      <div className="editor-body">
        <Palette onAdd={addAtCenter} />
        <div className="canvas-wrap" ref={canvasBox}>
          <Canvas
            wf={wf}
            selected={selected}
            errors={errors}
            onSelect={setSelected}
            onConnect={onConnect}
            onMove={(id, pos) => edit(patchNode(wf, id, { position: { x: Math.round(pos.x), y: Math.round(pos.y) } }))}
            onDropType={addAt}
          />
        </div>
        <SettingsPanel wf={wf} selected={selected} edit={edit} onSelect={setSelected} onRename={onRename} onDeleteSelected={deleteSelected} />
      </div>
    </div>
  );
}

export function WorkflowEditor({ tick = 0 }) {
  return (
    <ReactFlowProvider>
      <EditorBody tick={tick} />
    </ReactFlowProvider>
  );
}
