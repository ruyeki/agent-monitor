import { MarkerType } from '@xyflow/react';

// Workflow graph -> React Flow props. `selected` = {kind, id} and `errors` = {nodes:Set, edges:Set} for the editor,
// `runInfo` = {active:Set, nodes:{[id]:{visits, tokens}}} for the run view.
export function toFlow(wf, { selected, errors, runInfo } = {}) {
  const nodes = (wf.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'wf',
    position: n.position ?? { x: 0, y: 0 },
    selected: selected?.kind === 'node' && selected.id === n.id,
    data: {
      node: n,
      error: !!errors?.nodes.has(n.id),
      run: runInfo
        ? { active: runInfo.active.has(n.id), visits: runInfo.nodes[n.id]?.visits ?? 0, tokens: runInfo.nodes[n.id]?.tokens?.total }
        : null,
    },
  }));
  const edges = (wf.edges ?? []).map((e) => ({
    id: e.id,
    source: e.from,
    target: e.to,
    label: e.fixRound ? `${e.on} (fix round)` : e.on,
    markerEnd: { type: MarkerType.ArrowClosed },
    selected: selected?.kind === 'edge' && selected.id === e.id,
    className: errors?.edges.has(e.id) ? 'edge-error' : undefined,
    interactionWidth: 24,
  }));
  return { nodes, edges };
}

// Errors from the server ({message, node?, edge?}) -> the ids to highlight.
export function errorTargets(errors) {
  const nodes = new Set();
  const edges = new Set();
  for (const e of errors ?? []) {
    if (e?.node) nodes.add(e.node);
    if (e?.edge) edges.add(e.edge);
  }
  return { nodes, edges };
}
