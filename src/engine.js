// Pure workflow engine: state in, state out. No I/O.

const OUTCOMES = ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck'];
const DECISION_ACTIONS = [{ label: 'Resume', goto: 'resume' }, { label: 'Stop run', goto: 'stop' }];
const find = (wf, id) => wf.stages.find((s) => s.id === id);
const nextOf = (wf, id) => wf.stages[wf.stages.findIndex((s) => s.id === id) + 1]?.id ?? 'done';

// Moves into a stage and sets status and ask the way that stage needs.
function enter(wf, id, { round, verdict, ask }) {
  if (id === 'done' || id === 'stopped') return { stage: id, round, status: id, verdict, ask: null };
  if (id === 'decision') return { stage: id, round, status: 'waiting', verdict, ask: ask || 'Decision needed' };
  const s = find(wf, id);
  if (s?.kind === 'gate') return { stage: id, round, status: 'waiting', verdict, ask: s.ask };
  return { stage: id, round, status: 'active', verdict, ask: null };
}

export function startState(wf) {
  return enter(wf, wf.stages[0].id, { round: 0, verdict: null });
}

export function stop(state) {
  return { ...state, stage: 'stopped', status: 'stopped', ask: null };
}

export function completeStage(wf, state, { stage, outcome, note }) {
  if (state.status === 'done' || state.status === 'stopped') return { ok: false, error: `Run is already ${state.status}.` };
  if (stage !== state.stage) return { ok: false, error: `Run is at stage '${state.stage}', not '${stage}'.` };
  if (!OUTCOMES.includes(outcome)) return { ok: false, error: `Unknown outcome '${outcome}'. Use one of: ${OUTCOMES.join(', ')}.` };
  if (state.status === 'waiting') return { ok: false, error: `Run is waiting on Ryan at '${state.stage}'; use respond.` };

  const cur = find(wf, state.stage);
  const { loop } = wf;
  const keep = { round: state.round, verdict: outcome };
  const decide = () => enter(wf, 'decision', { ...keep, ask: note });

  if (outcome === 'pass' || outcome === 'done') {
    const to = state.stage === 'fix' ? loop.afterFix : nextOf(wf, state.stage);
    return { ok: true, state: enter(wf, to, keep) };
  }
  if (outcome === 'fail' || outcome === 'finding') {
    if (!cur?.check) return { ok: true, state: decide() };
    if (cur.check.onFail === 'continue') return { ok: true, state: enter(wf, nextOf(wf, cur.id), keep) };
    if (cur.check.onFail === 'decision') return { ok: true, state: decide() };
    if (state.round + 1 > loop.maxRounds) {
      const ask = `${note || 'Checks failed'} (fix round limit ${loop.maxRounds} reached)`;
      return { ok: true, state: enter(wf, 'decision', { ...keep, ask }) };
    }
    return { ok: true, state: enter(wf, 'fix', { ...keep, round: state.round + 1 }) };
  }
  return { ok: true, state: decide() }; // regression | env | stuck
}

function actionsFor(wf, state) {
  if (state.stage === 'decision') return DECISION_ACTIONS;
  return find(wf, state.stage)?.actions ?? [];
}

export function respond(wf, state, { action, text }) {
  if (state.status !== 'waiting') return { ok: false, error: `Run is not waiting on Ryan (status ${state.status}).` };
  const actions = actionsFor(wf, state);
  const want = String(action ?? '').trim().toLowerCase();
  const hit = actions.find((a) => a.label.trim().toLowerCase() === want);
  if (!hit) return { ok: false, error: `Unknown action '${action}'. Use one of: ${actions.map((a) => a.label).join(', ')}.` };

  let to = hit.goto;
  if (to === 'stop') to = 'stopped';
  else if (to === 'resume') to = wf.loop.resumeAt;
  else if (to === 'next') to = nextOf(wf, state.stage);
  return { ok: true, state: enter(wf, to, { round: 0, verdict: state.verdict }), answer: { action: hit.label, text: text ?? '' } };
}

export function describeStage(wf, id, state) {
  if (id === 'fix') {
    return {
      id, name: 'Fix', kind: 'step', runner: wf.loop.fixRunner, model: wf.loop.fixModel,
      instructions: 'Fix what the last check found. Make a root-cause change, not a patch over the symptom. When it is done, call complete_stage with the outcome.',
    };
  }
  if (id === 'decision') {
    return {
      id, name: 'Decision', kind: 'gate', runner: 'main', model: 'inherit', instructions: '',
      ask: state?.ask || 'Decision needed', actions: DECISION_ACTIONS.map(({ label }) => ({ label })), textField: true,
    };
  }
  if (id === 'done' || id === 'stopped') {
    return { id, name: id === 'done' ? 'Done' : 'Stopped', kind: 'end', runner: 'main', model: 'inherit', instructions: '' };
  }
  const s = find(wf, id);
  if (!s) return null;
  const out = { id: s.id, name: s.name, kind: s.kind, runner: s.runner, model: s.model, instructions: s.instructions };
  if (s.kind === 'gate') {
    out.ask = state?.stage === id && state.ask ? state.ask : s.ask;
    out.actions = s.actions;
    out.textField = s.textField;
  }
  return out;
}
