// Card size in the CSS (.fnode width) and the gaps between cards. Keep them in step with styles.css:
// the layer gap leaves room under a card (up to ~100 px with wrapped badges) for an edge and its label.
export const CARD_W = 220;
export const COL_GAP = 280;
export const LAYER_GAP = 160;

// Layered top-to-bottom layout: layer = longest path from the start node (back edges, found by a depth-first
// walk, are ignored), y = layer * LAYER_GAP. Nodes of one layer sit side by side, centred on x 0.
// The loop decision and every fix-round target go in a side column right of the main column, at their layer's
// y (pushed down when two would share a spot), so loop-back edges don't cross the main path.
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
  const side = new Set(edges.filter((e) => e.fixRound && ids.has(e.to)).map((e) => e.to));
  if (ids.has(wf.loop?.decision)) side.add(wf.loop.decision);
  const place = new Map();
  const layers = new Map();
  for (const n of nodes) {
    if (side.has(n.id)) continue;
    const d = depth.get(n.id);
    layers.set(d, [...(layers.get(d) ?? []), n.id]);
  }
  let maxX = -COL_GAP;
  for (const [d, list] of layers) {
    list.forEach((id, i) => {
      const x = (i - (list.length - 1) / 2) * COL_GAP;
      maxX = Math.max(maxX, x);
      place.set(id, { x, y: d * LAYER_GAP });
    });
  }
  let y = -Infinity;
  for (const n of nodes.filter((m) => side.has(m.id)).sort((a, b) => depth.get(a.id) - depth.get(b.id))) {
    y = Math.max(depth.get(n.id) * LAYER_GAP, y + LAYER_GAP);
    place.set(n.id, { x: maxX + COL_GAP, y });
  }
  return { ...wf, nodes: nodes.map((n) => ({ ...n, position: place.get(n.id) })) };
}
