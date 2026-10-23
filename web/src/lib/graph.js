export const STAGE_GAP = 220;
const LOWER_Y = 190;

// React Flow nodes and edges for a workflow; positions come from the order only. Edges to missing stages are dropped.
export function buildGraph(workflow) {
  const stages = workflow?.stages ?? [];
  const loop = workflow?.loop ?? {};
  const n = stages.length;
  const ids = new Set(stages.map((s) => s.id));
  const synthetic = { fix: 'Fix', decision: 'Decision', done: 'Done', stopped: 'Stopped' };
  const nodes = stages.map((s, i) => ({
    id: s.id,
    type: 'stage',
    position: { x: i * STAGE_GAP, y: 0 },
    draggable: true,
    data: { label: s.name, stage: s },
  }));
  const at = { fix: [1, LOWER_Y], decision: [2.5, LOWER_Y], done: [n, 0], stopped: [Math.max(n - 1, 3), LOWER_Y] };
  for (const [id, label] of Object.entries(synthetic)) {
    nodes.push({ id, type: 'synthetic', position: { x: at[id][0] * STAGE_GAP, y: at[id][1] }, draggable: false, data: { label } });
  }
  const valid = (id) => ids.has(id) || Object.hasOwn(synthetic, id);
  const edges = [];
  const add = (source, target, label) => {
    if (valid(source) && valid(target)) edges.push({ id: `${source}->${target}#${edges.length}`, source, target, label });
  };
  const following = (i) => (i + 1 < n ? stages[i + 1].id : 'done');
  stages.forEach((s, i) => {
    add(s.id, following(i), 'pass');
    if (s.check?.onFail === 'fix') add(s.id, 'fix', 'fail');
    if (s.check?.onFail === 'decision') add(s.id, 'decision', 'fail');
    if (s.kind === 'gate') {
      for (const a of s.actions ?? []) add(s.id, a.goto === 'next' ? following(i) : a.goto === 'stop' ? 'stopped' : a.goto, a.label);
    }
  });
  if (loop.afterFix) add('fix', loop.afterFix, 'done');
  if (loop.resumeAt) add('decision', loop.resumeAt, 'Resume');
  add('decision', 'stopped', 'Stop run');
  return { nodes, edges };
}
