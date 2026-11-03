const FAIL = new Set(['fail', 'finding', 'regression', 'env', 'stuck']);
const PASS = new Set(['pass', 'done']);

// Where one node stands, from its visits (in order; the last is the latest) and whether the run is on it now.
function stateOf(n, visits, { isActive, decision, runStatus, targetVisited }) {
  if (isActive) {
    if (n.id === decision) return ['decision', '✕ decision needed'];
    return n.type === 'gate' ? ['waiting', '⏸ waiting on Ryan'] : ['running', '▶ running'];
  }
  if (n.type === 'split' || n.type === 'join') return targetVisited ? ['passed', '✓ done'] : ['idle', null];
  const last = visits.at(-1);
  if (!last) return ['idle', null];
  if (n.type === 'end') return runStatus === 'done' ? ['passed', '✓ done'] : ['halted', '– stopped'];
  const o = last.outcome;
  if (FAIL.has(o)) return ['failed', `✕ ${o}`];
  if (PASS.has(o)) return ['passed', `✓ ${o}`];
  if (o === 'stopped' || o === 'cancelled') return ['halted', `– ${o}`];
  if (!o) return ['running', '▶ running']; // an open visit the run no longer lists as active
  return ['passed', `✓ ${o}`]; // an answered gate: the label of the action
}

// Run detail -> {[nodeId]: {state, status, fails, visits, tokens}} for toFlow's runInfo. The latest visit decides the state;
// `fails` counts earlier visits that ended in a failure outcome.
export function runState(detail) {
  const { run, workflow } = detail;
  const stats = detail.nodes ?? {};
  const byNode = new Map();
  for (const v of detail.visits ?? []) byNode.set(v.node, [...(byNode.get(v.node) ?? []), v]);
  const active = new Set((run.active ?? [{ id: run.stage }]).map((a) => a.id));
  const out = {};
  for (const n of workflow.nodes ?? []) {
    const visits = byNode.get(n.id) ?? [];
    const targetVisited = (workflow.edges ?? []).some((e) => e.from === n.id && byNode.has(e.to));
    const [state, status] = stateOf(n, visits, { isActive: active.has(n.id), decision: workflow.loop?.decision, runStatus: run.status, targetVisited });
    out[n.id] = {
      state,
      status,
      fails: visits.slice(0, -1).filter((v) => FAIL.has(v.outcome)).length,
      visits: stats[n.id]?.visits ?? 0,
      tokens: stats[n.id]?.tokens?.total ?? null,
    };
  }
  return out;
}
