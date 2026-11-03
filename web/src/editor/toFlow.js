import { MarkerType } from '@xyflow/react';
import { formatDuration, formatTokens } from '../lib/format.js';

// Per-node stats line for the editor, from one /api/stats/versions entry: {[id]: text}. A node missing from the
// map (draft-only, or no entry) gets no line. split and join nodes are transient (the engine never records a visit
// for them), so they get no line either; `wf` supplies their types.
export function nodeStats(entry, wf) {
  if (!entry) return undefined;
  const transient = new Set((wf?.nodes ?? []).filter((n) => n.type === 'split' || n.type === 'join').map((n) => n.id));
  const out = {};
  for (const n of entry.nodes ?? []) {
    if (transient.has(n.id)) continue;
    out[n.id] = !entry.finishedRuns
      ? 'no runs yet'
      : !n.runs
        ? 'never reached'
        : `≈ ${formatTokens(n.avgTokens)} tokens · ${formatDuration(n.avgDurationMs)} avg`;
  }
  return out;
}

// Workflow graph -> React Flow props. `selected` = {kind, id}, `errors` = {nodes:Set, edges:Set} and `stats` =
// nodeStats() for the editor; `runInfo` = {[id]: {state, status, fails, visits, tokens}} (see run/runState.js) for the run view.
// `codex` = Set of node ids a Codex visit ran (run view); adds the Codex badge.
export function toFlow(wf, { selected, errors, stats, runInfo, codex } = {}) {
  const nodes = (wf.nodes ?? []).map((n) => ({
    id: n.id,
    type: 'wf',
    position: n.position ?? { x: 0, y: 0 },
    selected: selected?.kind === 'node' && selected.id === n.id,
    data: {
      node: n,
      error: !!errors?.nodes.has(n.id),
      stats: stats?.[n.id],
      run: runInfo ? { ...runInfo[n.id], codex: !!codex?.has(n.id) } : null,
    },
  }));
  // Edges between the same two nodes draw the same path, so one label would overprint the others: the first edge of
  // each from>to group carries every outcome ("regression / env / stuck"), the rest none.
  const groups = new Map();
  for (const e of wf.edges ?? []) {
    const key = `${e.from}>${e.to}`;
    if (!groups.has(key)) groups.set(key, { first: e.id, ons: [] });
    groups.get(key).ons.push(e.on);
  }
  const edges = (wf.edges ?? []).map((e) => {
    const g = groups.get(`${e.from}>${e.to}`);
    return {
      id: e.id,
      source: e.from,
      target: e.to,
      label: g.first === e.id ? g.ons.join(' / ') : undefined,
      markerEnd: { type: MarkerType.ArrowClosed },
      selected: selected?.kind === 'edge' && selected.id === e.id,
      className: [e.fixRound && 'edge-fix', errors?.edges.has(e.id) && 'edge-error'].filter(Boolean).join(' ') || undefined,
      interactionWidth: 24,
    };
  });
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
