import { STAGE_GAP } from './graph.js';

export function moveStage(stages, id, toIndex) {
  const from = stages.findIndex((s) => s.id === id);
  if (from < 0) return stages.slice();
  const rest = stages.filter((_, i) => i !== from);
  rest.splice(Math.min(Math.max(toIndex, 0), stages.length - 1), 0, stages[from]);
  return rest;
}

// A dropped node's x position decides the slot it lands in.
export function reorderByDrop(stages, id, dropX) {
  return moveStage(stages, id, Math.round(dropX / STAGE_GAP));
}
