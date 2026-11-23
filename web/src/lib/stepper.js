// The stage stepper of a Fleet card: one segment per pipeline stage, in workflow order. split / join / end nodes and
// the loop-only nodes (fix-round targets and the loop decision) are left out; each segment's state comes from runState.
import { runState } from '../run/runState.js';

const HIDDEN_TYPES = new Set(['split', 'join', 'end']);
const STEP = { passed: 'done', running: 'current', waiting: 'waiting', decision: 'waiting', failed: 'failed' };

// detail -> [{id, name, state}] with state done | current | waiting | failed | todo.
export function stageSteps(detail) {
  const wf = detail?.workflow;
  if (!detail?.run || !Array.isArray(wf?.nodes)) return [];
  const loopOnly = new Set((wf.edges ?? []).filter((e) => e?.fixRound).map((e) => e.to));
  if (wf.loop?.decision) loopOnly.add(wf.loop.decision);
  const info = runState(detail);
  return wf.nodes
    .filter((n) => n && !HIDDEN_TYPES.has(n.type) && !loopOnly.has(n.id))
    .map((n) => ({ id: n.id, name: n.name || n.id, state: STEP[info[n.id]?.state] ?? 'todo' }));
}
