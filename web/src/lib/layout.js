const LAYER_GAP = 220;
const ROW_GAP = 140;

// Layered left-to-right layout: x = depth * LAYER_GAP, where depth is the longest path from the start node
// (back edges, found by a depth-first walk, are ignored). Nodes in one layer stack down in node order.
export function autoLayout(wf) {
  const nodes = wf.nodes ?? [];
  const edges = wf.edges ?? [];
  const ids = new Set(nodes.map((n) => n.id));
  const out = new Map(nodes.map((n) => [n.id, []]));
  const hasIn = new Set();
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) continue;
    out.get(e.from).push(e.to);
    hasIn.add(e.to);
  }
  const roots = nodes.filter((n) => !hasIn.has(n.id)).map((n) => n.id);
  const state = new Map(); // 1 = on the stack, 2 = finished
  const back = new Set(); // "from>to" keys
  const post = [];
  const walk = (id) => {
    state.set(id, 1);
    for (const to of out.get(id)) {
      if (state.get(to) === 1) back.add(`${id}>${to}`);
      else if (!state.has(to)) walk(to);
    }
    state.set(id, 2);
    post.push(id);
  };
  for (const id of [...roots, ...nodes.map((n) => n.id)]) if (!state.has(id)) walk(id);

  const depth = new Map(nodes.map((n) => [n.id, 0]));
  for (const id of post.reverse()) {
    for (const to of out.get(id)) {
      if (!back.has(`${id}>${to}`)) depth.set(to, Math.max(depth.get(to), depth.get(id) + 1));
    }
  }
  const rows = new Map();
  return {
    ...wf,
    nodes: nodes.map((n) => {
      const d = depth.get(n.id);
      const row = rows.get(d) ?? 0;
      rows.set(d, row + 1);
      return { ...n, position: { x: d * LAYER_GAP, y: row * ROW_GAP } };
    }),
  };
}
