import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmp = (name = 'am-test') => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
export const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

// Walks a run to the given stage by passing everything before it (answering gates with their first action).
export function advance(store, id, untilStage) {
  for (let i = 0; i < 40 && store.getRun(id).stage !== untilStage; i++) {
    const r = store.getRun(id);
    const res = r.status === 'waiting'
      ? store.respond(id, { action: store.summary(r).actions[0].label })
      : store.completeStage(id, { stage: r.stage, outcome: 'pass' });
    if (res.error) throw new Error(res.error);
  }
}

export const jsonHeaders = { 'Content-Type': 'application/json' };
