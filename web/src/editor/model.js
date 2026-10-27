// Pure edits on a graph workflow {nodes, edges, loop}. Never mutate; the editor keeps the draft in React state.
export const NODE_TYPES = ['step', 'check', 'gate', 'split', 'join', 'end'];
export const OUTCOMES = ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck'];
export const RUNNERS = ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom'];
export const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const TYPE_NAME = { step: 'Step', check: 'Check', gate: 'Gate', split: 'Split', join: 'Join', end: 'End' };

const nodesOf = (wf) => wf.nodes ?? [];
const edgesOf = (wf) => wf.edges ?? [];
const nodeOf = (wf, id) => nodesOf(wf).find((n) => n.id === id);

function uniqueId(base, used) {
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

const gateFields = () => ({ ask: 'Your call?', actions: [{ label: 'Continue' }, { label: 'Stop run' }], textField: true });

export function addNode(wf, type, position) {
  const id = uniqueId(type, new Set(nodesOf(wf).map((n) => n.id)));
  const node = {
    id,
    type,
    name: `New ${type}`,
    runner: type === 'check' ? 'verifier' : type === 'step' ? 'worker' : 'main',
    model: 'inherit',
    instructions: '',
    pushes: false,
    position: { x: Math.round(position?.x ?? 0), y: Math.round(position?.y ?? 0) },
    ...(type === 'gate' ? gateFields() : {}),
  };
  return { ...wf, nodes: [...nodesOf(wf), node] };
}

export function removeNode(wf, id) {
  return { ...wf, nodes: nodesOf(wf).filter((n) => n.id !== id), edges: edgesOf(wf).filter((e) => e.from !== id && e.to !== id) };
}

// The `on` a new edge from `node` gets when the user does not choose one.
function defaultOn(wf, node) {
  const used = new Set(edgesOf(wf).filter((e) => e.from === node.id).map((e) => e.on));
  if (node.type === 'step') return 'done';
  if (node.type === 'check') return ['pass', 'fail'].find((o) => !used.has(o)) ?? 'pass';
  if (node.type === 'gate') {
    const labels = (node.actions ?? []).map((a) => a.label);
    return labels.find((l) => !used.has(l)) ?? labels[0] ?? '*';
  }
  return '*';
}

export function connect(wf, from, to, on) {
  const src = nodeOf(wf, from);
  if (!src || !nodeOf(wf, to) || src.type === 'end') return wf;
  const when = on ?? defaultOn(wf, src);
  if (edgesOf(wf).some((e) => e.from === from && e.to === to && e.on === when)) return wf;
  const used = new Set(edgesOf(wf).map((e) => e.id));
  const base = `${from}>${to}:${when}`;
  const id = used.has(base) ? uniqueId(base, used) : base;
  return { ...wf, edges: [...edgesOf(wf), { id, from, to, on: when }] };
}

export const removeEdge = (wf, id) => ({ ...wf, edges: edgesOf(wf).filter((e) => e.id !== id) });

export const patchNode = (wf, id, patch) => ({ ...wf, nodes: nodesOf(wf).map((n) => (n.id === id ? { ...n, ...patch } : n)) });

export const patchEdge = (wf, id, patch) => ({ ...wf, edges: edgesOf(wf).map((e) => (e.id === id ? { ...e, ...patch } : e)) });

// Changes a node's type, adding or dropping the gate-only fields.
export function setNodeType(wf, id, type) {
  const n = nodeOf(wf, id);
  if (!n || n.type === type) return wf;
  const { ask, actions, textField, ...rest } = n;
  const next = type === 'gate' ? { ...rest, type, ...gateFields() } : { ...rest, type };
  return { ...wf, nodes: nodesOf(wf).map((x) => (x.id === id ? next : x)) };
}

// Why `to` cannot be the new id of node `from`, or null when it can.
export function idProblem(wf, from, to) {
  if (!to) return 'The id cannot be empty.';
  if (to.length > 80 || !ID_RE.test(to)) return 'Use lowercase letters, digits, - and _, starting with a letter (80 characters at most).';
  if (to !== from && nodeOf(wf, to)) return `Another node already uses '${to}'.`;
  return null;
}

// Renames a node id and every reference to it (edges, loop.decision).
export function renameNode(wf, from, to) {
  const swap = (v) => (v === from ? to : v);
  return {
    ...wf,
    nodes: nodesOf(wf).map((n) => (n.id === from ? { ...n, id: to } : n)),
    edges: edgesOf(wf).map((e) => ({ ...e, from: swap(e.from), to: swap(e.to) })),
    loop: wf.loop ? { ...wf.loop, decision: swap(wf.loop.decision) } : wf.loop,
  };
}

const setActions = (wf, id, actions) => patchNode(wf, id, { actions });

export function addAction(wf, id) {
  const actions = nodeOf(wf, id)?.actions ?? [];
  const labels = new Set(actions.map((a) => a.label));
  let n = labels.size + 1;
  while (labels.has(`Action ${n}`)) n += 1;
  return setActions(wf, id, [...actions, { label: `Action ${n}` }]);
}

// Renames a gate action and the `on` of the edges that use it.
export function renameAction(wf, id, index, label) {
  const actions = nodeOf(wf, id)?.actions ?? [];
  const old = actions[index]?.label;
  if (old === undefined) return wf;
  const next = setActions(wf, id, actions.map((a, i) => (i === index ? { ...a, label } : a)));
  return { ...next, edges: edgesOf(next).map((e) => (e.from === id && e.on === old ? { ...e, on: label } : e)) };
}

// Removes a gate action and the edges that leave on it.
export function removeAction(wf, id, index) {
  const actions = nodeOf(wf, id)?.actions ?? [];
  const old = actions[index]?.label;
  if (old === undefined) return wf;
  const next = setActions(wf, id, actions.filter((_, i) => i !== index));
  return { ...next, edges: edgesOf(next).filter((e) => !(e.from === id && e.on === old)) };
}

// The `on` values an edge leaving `node` may use.
export function onChoices(node) {
  if (!node) return [];
  if (node.type === 'step' || node.type === 'check') return [...OUTCOMES, '*'];
  if (node.type === 'gate') return (node.actions ?? []).map((a) => a.label);
  if (node.type === 'end') return [];
  return ['*'];
}

export const typeName = (type) => TYPE_NAME[type] ?? type;
