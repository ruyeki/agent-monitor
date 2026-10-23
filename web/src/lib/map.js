const GATE_LANE = 'you';

// Pure layout model for the swimlane map; the Workflow editor can reuse it.
// columns: spine stages in order, then "done". lanes: runners that appear (gates sit in "you").
export function buildMap(workflow, run, timeline = []) {
  const stages = workflow?.stages || [];
  const visited = new Set((timeline || []).filter((e) => e.kind === 'stage' && e.stage).map((e) => e.stage));
  const current = run?.stage;
  const mark = (n) => ({ ...n, current: n.id === current, visited: visited.has(n.id) && n.id !== current });

  const columns = stages.map((s) =>
    mark({ id: s.id, name: s.name, kind: s.kind, lane: s.kind === 'gate' ? GATE_LANE : s.runner, model: s.model, hasCheck: !!s.check }),
  );
  const ended = run?.status === 'done' || run?.status === 'stopped';
  columns.push({
    id: 'done',
    name: run?.status === 'stopped' ? 'Stopped' : 'Done',
    kind: 'end',
    lane: null,
    current: ended,
    visited: false,
  });
  const lanes = [];
  for (const c of columns) if (c.lane && !lanes.includes(c.lane)) lanes.push(c.lane);

  const side = [
    mark({ id: 'fix', name: 'Fix', kind: 'fix', lane: workflow?.loop?.fixRunner || 'worker' }),
    mark({ id: 'decision', name: 'Decision', kind: 'decision', lane: GATE_LANE }),
  ];
  return { columns, lanes, side, status: run?.status, round: run?.round ?? 0, maxRounds: run?.maxRounds };
}
