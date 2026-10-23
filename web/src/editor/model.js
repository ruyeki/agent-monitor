// Pure edits on a workflow object (never mutate; the editor keeps the draft in React state).
export const RUNNERS = ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom'];
export const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];
export const CHECKS = ['none', 'fix', 'decision', 'continue'];

export function newStageId(stages, kind) {
  const base = kind === 'gate' ? 'gate' : 'step';
  const used = new Set(stages.map((s) => s.id));
  let n = 2;
  while (used.has(`${base}-${n}`)) n += 1;
  return `${base}-${n}`;
}

export function defaultStage(stages, kind) {
  const id = newStageId(stages, kind);
  if (kind === 'gate') {
    return {
      id, name: 'New gate', kind, runner: 'main', model: 'inherit', instructions: '', check: null, pushes: false,
      ask: 'Your call?', actions: [{ label: 'Continue', goto: 'next' }, { label: 'Stop run', goto: 'stop' }], textField: true,
    };
  }
  return { id, name: 'New step', kind: 'step', runner: 'worker', model: 'inherit', instructions: '', check: null, pushes: false };
}

export function insertAfter(wf, afterId, stage) {
  const i = wf.stages.findIndex((s) => s.id === afterId);
  const at = i < 0 ? wf.stages.length : i + 1;
  return { ...wf, stages: [...wf.stages.slice(0, at), stage, ...wf.stages.slice(at)] };
}

export function patchStage(wf, id, patch) {
  return { ...wf, stages: wf.stages.map((s) => (s.id === id ? { ...s, ...patch } : s)) };
}

export function setKind(wf, id, kind) {
  const s = wf.stages.find((x) => x.id === id);
  if (!s || s.kind === kind) return wf;
  if (kind === 'gate') {
    const g = defaultStage([], 'gate');
    return patchStage(wf, id, { kind, ask: g.ask, actions: g.actions, textField: true });
  }
  const { ask, actions, textField, ...rest } = s;
  return { ...wf, stages: wf.stages.map((x) => (x.id === id ? { ...rest, kind } : x)) };
}

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const RESERVED = ['fix', 'decision', 'done', 'stopped', 'next', 'stop'];

// Why `to` cannot be the new id of stage `from`, or null when it can.
export function idProblem(wf, from, to) {
  if (!to) return 'The id cannot be empty.';
  if (!ID_RE.test(to)) return 'Use lowercase letters, digits, - and _, starting with a letter.';
  if (RESERVED.includes(to)) return `'${to}' is a reserved id.`;
  if (to !== from && wf.stages.some((s) => s.id === to)) return `Another stage already uses '${to}'.`;
  return null;
}

// Renames a stage id and every reference to it.
export function renameStage(wf, from, to) {
  const swap = (v) => (v === from ? to : v);
  return {
    ...wf,
    stages: wf.stages.map((s) => {
      const t = s.id === from ? { ...s, id: to } : s;
      return t.actions ? { ...t, actions: t.actions.map((a) => ({ ...a, goto: swap(a.goto) })) } : t;
    }),
    loop: { ...wf.loop, afterFix: swap(wf.loop?.afterFix), resumeAt: swap(wf.loop?.resumeAt) },
  };
}

export function removeStage(wf, id) {
  const stages = wf.stages.filter((s) => s.id !== id).map((s) =>
    s.actions ? { ...s, actions: s.actions.map((a) => (a.goto === id ? { ...a, goto: 'next' } : a)) } : s,
  );
  const first = stages[0]?.id ?? '';
  const fix = (v) => (v === id ? first : v);
  return { ...wf, stages, loop: { ...wf.loop, afterFix: fix(wf.loop?.afterFix), resumeAt: fix(wf.loop?.resumeAt) } };
}
