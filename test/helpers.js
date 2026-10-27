import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const tmp = (name = 'am-test') => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
export const fixture = (name) => path.join(import.meta.dirname, 'fixtures', name);

// Walks a run until the given node is active by passing active nodes one at a time (answering gates with their first action).
export function advance(store, id, untilStage) {
  const active = () => store.summary(store.getRun(id)).active.map((a) => a.id);
  for (let i = 0; i < 40 && !active().includes(untilStage); i++) {
    const r = store.getRun(id);
    if (r.status === 'done' || r.status === 'stopped') throw new Error(`Run ended before reaching '${untilStage}'.`);
    const res = r.status === 'waiting'
      ? store.respond(id, { action: store.summary(r).actions[0].label })
      : store.completeStage(id, { stage: active()[0], outcome: 'pass' });
    if (res.error) throw new Error(res.error);
  }
}

export const jsonHeaders = { 'Content-Type': 'application/json' };
