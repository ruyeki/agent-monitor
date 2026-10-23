import '@xyflow/react/dist/style.css';
import { Background, MarkerType, ReactFlow, useNodesState } from '@xyflow/react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { discardDraft, getVersions, getWorkflow, loadVersion, publishDraft, putDraft } from '../api.js';
import { buildGraph } from '../lib/graph.js';
import { reorderByDrop } from '../lib/reorder.js';
import { defaultStage, insertAfter, removeStage, renameStage } from './model.js';
import { LoopPanel, StagePanel } from './StagePanel.jsx';
import { StageNode, SyntheticNode } from './StageNode.jsx';

const nodeTypes = { stage: StageNode, synthetic: SyntheticNode };
const SAVE_DELAY = 400;
const STATUS_TEXT = { saved: 'Draft — saved', unsaved: 'Draft — unsaved changes', saving: 'Draft — saving…', error: 'Draft — save failed' };
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

export function WorkflowEditor({ tick = 0 }) {
  const [published, setPublished] = useState(null);
  const [wf, setWf] = useState(null);
  const [errors, setErrors] = useState([]);
  const [status, setStatus] = useState('saved');
  const [problem, setProblem] = useState(null); // load / save / publish failures
  const [versions, setVersions] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [confirm, setConfirm] = useState(null); // {what: 'discard'|'delete'|'load', id?, version?}
  const wfRef = useRef(null);
  const dirty = useRef(false);
  const timer = useRef(null);
  const seq = useRef(0);

  const load = useCallback(async (force) => {
    const mine = seq.current; // an edit made while the fetch is in flight makes its result stale
    try {
      const [state, list] = await Promise.all([getWorkflow(), getVersions()]);
      setPublished(state.published);
      setVersions(list);
      if (seq.current === mine && (force || !dirty.current)) {
        dirty.current = false;
        setErrors(state.draft.errors ?? []);
        setStatus('saved');
        if (!same(state.draft.workflow, wfRef.current)) {
          wfRef.current = state.draft.workflow;
          setWf(state.draft.workflow);
        }
      }
      setProblem(null);
    } catch (e) {
      setProblem(`Could not load the workflow: ${e.message}`);
    }
  }, []);
  useEffect(() => {
    load(false); // also runs on every SSE tick; unsaved local edits are kept
  }, [load, tick]);

  const save = useCallback(async () => {
    clearTimeout(timer.current);
    const mine = seq.current;
    setStatus('saving');
    try {
      const draft = await putDraft(wfRef.current);
      if (seq.current === mine) {
        setErrors(draft?.errors ?? []);
        setProblem(null);
        dirty.current = false;
        setStatus('saved');
      }
      return true;
    } catch (e) {
      if (seq.current === mine) {
        setStatus('error');
        setProblem(`Could not save the draft: ${e.message}`);
      }
      return false;
    }
  }, []);

  const edit = useCallback(
    (next) => {
      wfRef.current = next;
      dirty.current = true;
      seq.current += 1;
      setWf(next);
      setStatus('unsaved');
      clearTimeout(timer.current);
      timer.current = setTimeout(save, SAVE_DELAY);
    },
    [save],
  );

  // Unmounting with a pending edit saves it instead of dropping it.
  useEffect(
    () => () => {
      clearTimeout(timer.current);
      if (dirty.current && wfRef.current) putDraft(wfRef.current).catch(() => {});
    },
    [],
  );

  const stages = wf?.stages ?? [];
  const selected = stages.find((s) => s.id === selectedId) ?? null;
  const hasChanges = !!wf && !!published && (status !== 'saved' || !same(wf, published.workflow));

  const graph = useMemo(() => {
    if (!wf) return { nodes: [], edges: [] };
    const g = buildGraph(wf);
    return {
      nodes: g.nodes.map((n) => ({ ...n, selected: n.id === selectedId, data: { ...n.data, selected: n.id === selectedId } })),
      edges: g.edges.map((e) => ({ ...e, markerEnd: { type: MarkerType.ArrowClosed } })),
    };
  }, [wf, selectedId]);
  const [nodes, setNodes, onNodesChange] = useNodesState(graph.nodes);
  useEffect(() => setNodes(graph.nodes), [graph.nodes, setNodes]);

  const onDragStop = (_e, node) => {
    if (node.type === 'stage') {
      const next = reorderByDrop(stages, node.id, node.position.x);
      if (next.some((s, i) => s !== stages[i])) edit({ ...wf, stages: next });
    }
    setNodes(graph.nodes); // snap to the derived slot
  };

  const add = (kind) => {
    const s = defaultStage(stages, kind);
    edit(insertAfter(wf, selectedId, s));
    setSelectedId(s.id);
  };
  const rename = (from, to) => {
    edit(renameStage(wf, from, to));
    setSelectedId(to);
  };

  const runConfirm = async () => {
    const c = confirm;
    setConfirm(null);
    try {
      if (c.what === 'delete') {
        edit(removeStage(wf, c.id));
        setSelectedId(null);
        return;
      }
      clearTimeout(timer.current);
      seq.current += 1; // a save still in flight belongs to the draft being thrown away
      if (c.what === 'discard') await discardDraft();
      else await loadVersion(c.version);
      setSelectedId(null);
      await load(true);
    } catch (e) {
      setProblem(e.message);
    }
  };

  const askLoad = async (version) => {
    if (hasChanges) return setConfirm({ what: 'load', version });
    try {
      await loadVersion(version);
      await load(true);
    } catch (e) {
      setProblem(e.message);
    }
  };

  const publish = async () => {
    if (dirty.current && !(await save())) return;
    try {
      await publishDraft();
      setErrors([]);
      await load(true);
    } catch (e) {
      if (e.body?.errors) setErrors(e.body.errors);
      else setProblem(`Could not publish: ${e.message}`);
    }
  };

  if (!wf) {
    return problem ? (
      <p className="error" role="alert">
        {problem}
      </p>
    ) : (
      <p className="muted">Loading workflow…</p>
    );
  }

  return (
    <div className="editor">
      <div className="editor-bar">
        <strong>{published ? `Published v${published.version}` : 'Not published'}</strong>
        <span role="status">{STATUS_TEXT[status]}</span>
        <span className="spacer" />
        <button type="button" onClick={() => add('step')}>
          Add step
        </button>
        <button type="button" onClick={() => add('gate')}>
          Add gate
        </button>
        <button type="button" onClick={() => setConfirm({ what: 'discard' })}>
          Discard draft
        </button>
        <button type="button" className="primary" onClick={publish}>
          Publish
        </button>
      </div>
      {problem && (
        <p className="error" role="alert">
          {problem}
        </p>
      )}
      {errors.length > 0 && (
        <div className="error" aria-label="Draft problems">
          <strong>The draft has problems:</strong>
          <ul>
            {errors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </div>
      )}
      {confirm && (
        <div className="confirm" role="alertdialog" aria-label="Confirm">
          <span>
            {confirm.what === 'discard' && 'Discard the draft and go back to the published workflow?'}
            {confirm.what === 'delete' && `Delete stage ${confirm.id}?`}
            {confirm.what === 'load' && `Replace the draft with version ${confirm.version}? Your draft changes will be lost.`}
          </span>
          <button type="button" className="danger" onClick={runConfirm}>
            Confirm
          </button>
          <button type="button" onClick={() => setConfirm(null)}>
            Cancel
          </button>
        </div>
      )}
      <p className="muted legend">Any step: regression, env or stuck -&gt; Decision</p>
      <div className="editor-main">
        <div className="editor-left">
          <div className="flow" role="group" aria-label="Workflow graph">
            <ReactFlow
              nodes={nodes}
              edges={graph.edges}
              nodeTypes={nodeTypes}
              onNodesChange={onNodesChange}
              onNodeDragStop={onDragStop}
              onNodeClick={(_e, n) => n.type === 'stage' && setSelectedId(n.id)}
              onPaneClick={() => setSelectedId(null)}
              nodesConnectable={false}
              deleteKeyCode={null}
              defaultViewport={{ x: 24, y: 70, zoom: 0.75 }}
              minZoom={0.6}
            >
              <Background />
            </ReactFlow>
          </div>
          <nav aria-label="Stages">
            <ol className="stage-list">
              {stages.map((s, i) => (
                <li key={`${i}-${s.id}`}>
                  <button type="button" aria-pressed={s.id === selectedId} className={s.id === selectedId ? 'active' : ''} onClick={() => setSelectedId(s.id)}>
                    {i + 1}. {s.name || s.id}
                  </button>
                </li>
              ))}
              <li>
                <button type="button" aria-pressed={!selected} className={!selected ? 'active' : ''} onClick={() => setSelectedId(null)}>
                  Loop settings
                </button>
              </li>
            </ol>
          </nav>
        </div>
        <aside className="panel">
          {selected ? (
            <StagePanel wf={wf} stage={selected} edit={edit} onRename={rename} onDelete={() => setConfirm({ what: 'delete', id: selected.id })} />
          ) : (
            <LoopPanel wf={wf} edit={edit} />
          )}
        </aside>
      </div>
      <section aria-labelledby="versions-h">
        <h3 id="versions-h">Version history</h3>
        <table>
          <thead>
            <tr>
              <th>Version</th>
              <th>Published</th>
              <th>Stages</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {versions.map((v) => (
              <tr key={v.version}>
                <td>v{v.version}</td>
                <td>{new Date(v.publishedAt).toLocaleString()}</td>
                <td>{v.stages}</td>
                <td>
                  <button type="button" aria-label={`Load v${v.version} into draft`} onClick={() => askLoad(v.version)}>
                    Load into draft
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
