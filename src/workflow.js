// Workflow model: the stage list, its defaults, the seed v1 and the validation rules.

export const SYNTHETIC = ['fix', 'decision', 'done', 'stopped'];
export const RUNNERS = ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom'];
export const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];
export const ON_FAIL = ['fix', 'decision', 'continue'];

const ID_RE = /^[a-z][a-z0-9_-]*$/;
const DONE = 'When it is done, call complete_stage with the outcome.';

const step = (id, name, runner, model, instructions, extra = {}) => ({
  id, name, kind: 'step', runner, model, instructions: `${instructions} ${DONE}`, check: null, pushes: false, ...extra,
});
const gate = (id, name, ask, actions) => ({
  id, name, kind: 'gate', runner: 'main', model: 'inherit', instructions: '', check: null, pushes: false,
  ask, actions, textField: true,
});

export function seedWorkflow() {
  return {
    stages: [
      step('frame', 'Frame', 'main', 'inherit',
        'Investigate the task read-only and show Ryan the problem card. Do not agree a spec here: Gate 1 asks for his solution.'),
      gate('gate1', 'Gate 1: solution', "What's your solution?", [
        { label: 'Agree spec', goto: 'next' },
        { label: 'Stop run', goto: 'stop' },
      ]),
      step('plan', 'Plan', 'lead', 'opus',
        'After Gate 1, write the agreed spec into the task and spawn the lead with RUN: <id> in its brief. Write one fact sheet with the files, contracts and gotchas. Plan the work in small pieces. Agents read the fact sheet instead of exploring again.'),
      step('implement', 'Implement', 'worker', 'sonnet',
        'Run the worker and the verifier prep in parallel, in the foreground. The worker builds exactly the spec in its scope and never commits. The verifier writes the baseline and holdout tests.'),
      step('verify', 'Verify', 'verifier', 'sonnet',
        'Run the targeted tests, not the full suite. Report pass, or fail with the failing behaviour. Report a regression as regression. Never edit product code.',
        { check: { onFail: 'fix' } }),
      step('review', 'Review', 'lead', 'inherit',
        'Read the diff against the spec. Run the ponytail debloat pass and keep behaviour the same. Report any real problem as a finding. Never remove validation, error handling, security checks or tests.',
        { check: { onFail: 'fix' } }),
      step('whitehat', 'White-hat', 'white-hat', 'sonnet',
        'Attack the diff: injection, path traversal, missing access checks, resource abuse, secrets in logs. Report only findings with a proven attack path. Skip it for copy, CSS or docs changes.',
        { check: { onFail: 'fix' } }),
      step('commit', 'Commit', 'lead', 'inherit',
        'Move the verifier tests into the repo test folder. Commit locally with a message that explains why. Never push and never commit secrets.'),
      step('report', 'Report', 'lead', 'inherit',
        'Check each acceptance criterion against evidence. Write the six-part report: what was done, how it works, code changes, verification, review rounds, open concerns. Never claim a test passed unless it ran.'),
      gate('gate2', 'Gate 2: accept', 'Accept, push and open the PR?', [
        { label: 'Accept', goto: 'next' },
        { label: 'Request changes', goto: 'plan' },
        { label: 'Stop run', goto: 'stop' },
      ]),
      step('pr', 'Open PR', 'main', 'inherit',
        'Push the branch, and only that branch. Open a draft PR with a clear title, the summary, the verification results and the open concerns. Put the PR link in the note.',
        { pushes: true }),
    ],
    loop: { maxRounds: 5, fixRunner: 'worker', fixModel: 'sonnet', afterFix: 'verify', resumeAt: 'plan' },
  };
}

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dflt = (v, d) => (v === undefined ? d : v);

// Fills defaults. Never invents ids, names or runners, so validation can still catch those.
export function normalizeWorkflow(wf) {
  const src = isObj(wf) ? wf : {};
  const loop = isObj(src.loop) ? src.loop : {};
  const stages = (Array.isArray(src.stages) ? src.stages : []).filter(isObj).map((s) => {
    const isGate = s.kind === 'gate';
    const out = {
      id: s.id, name: s.name, kind: isGate ? 'gate' : 'step',
      runner: s.runner ?? (isGate ? 'main' : undefined), model: s.model ?? 'inherit',
      instructions: typeof s.instructions === 'string' ? s.instructions : '',
      check: isObj(s.check) ? { onFail: s.check.onFail ?? 'fix' } : null,
      pushes: s.pushes === true,
    };
    if (isGate) {
      out.ask = typeof s.ask === 'string' ? s.ask : '';
      out.actions = (Array.isArray(s.actions) ? s.actions : []).filter(isObj).map((a) => ({ label: a.label, goto: a.goto }));
      out.textField = s.textField !== false;
    }
    return out;
  });
  return {
    stages,
    // A default fills only a missing key; null or a wrong type is kept so validation reports it.
    loop: {
      maxRounds: dflt(loop.maxRounds, 5), fixRunner: dflt(loop.fixRunner, 'worker'), fixModel: dflt(loop.fixModel, 'sonnet'),
      afterFix: dflt(loop.afterFix, 'verify'), resumeAt: dflt(loop.resumeAt, 'plan'),
    },
  };
}

export function validateWorkflow(input) {
  const wf = normalizeWorkflow(input);
  const errors = [];
  const ids = new Set();
  const label = (s, i) => (typeof s.id === 'string' && s.id ? `Stage '${s.id}'` : `Stage number ${i + 1}`);
  if (!wf.stages.length) errors.push('The workflow needs at least one stage.');

  wf.stages.forEach((s, i) => {
    const who = label(s, i);
    if (typeof s.id !== 'string' || !s.id.trim()) errors.push(`${who} has no id.`);
    else if (!ID_RE.test(s.id)) errors.push(`${who} has an invalid id. Use lowercase letters, digits, - and _, starting with a letter.`);
    else if (SYNTHETIC.includes(s.id) || s.id === 'next' || s.id === 'stop') errors.push(`${who} uses a reserved id.`);
    else if (ids.has(s.id)) errors.push(`${who} has an id that another stage already uses.`);
    if (typeof s.id === 'string') ids.add(s.id);
    if (typeof s.name !== 'string' || !s.name.trim()) errors.push(`${who} has no name.`);
    if (!MODELS.includes(s.model)) errors.push(`${who} has an unknown model '${s.model}'.`);
    if (s.kind === 'step' && !RUNNERS.includes(s.runner)) errors.push(`${who} has an unknown runner '${s.runner}'.`);
    if (s.check && !ON_FAIL.includes(s.check.onFail)) errors.push(`${who} has an unknown onFail '${s.check.onFail}'.`);
  });

  wf.stages.forEach((s, i) => {
    if (s.kind !== 'gate') return;
    const who = label(s, i);
    if (!s.ask.trim()) errors.push(`${who} is a gate and needs a question to ask.`);
    if (!s.actions.length) errors.push(`${who} is a gate and needs at least one action.`);
    for (const a of s.actions) {
      if (typeof a.label !== 'string' || !a.label.trim()) errors.push(`${who} has an action with no label.`);
      else if (!['next', 'stop'].includes(a.goto) && !ids.has(a.goto)) errors.push(`${who} action '${a.label}' goes to '${a.goto}', which is not a stage.`);
    }
  });

  const { loop } = wf;
  if (!Number.isInteger(loop.maxRounds) || loop.maxRounds < 1 || loop.maxRounds > 10) errors.push('The fix loop needs maxRounds as a whole number from 1 to 10.');
  if (!RUNNERS.includes(loop.fixRunner)) errors.push(`The fix loop fixRunner '${loop.fixRunner}' is not a known runner.`);
  if (!MODELS.includes(loop.fixModel)) errors.push(`The fix loop fixModel '${loop.fixModel}' is not a known model.`);
  if (!ids.has(loop.afterFix)) errors.push(`The fix loop afterFix '${loop.afterFix}' is not a stage.`);
  if (!ids.has(loop.resumeAt)) errors.push(`The fix loop resumeAt '${loop.resumeAt}' is not a stage.`);

  const checks = wf.stages.map((s, i) => (s.check ? i : -1)).filter((i) => i >= 0);
  if (wf.stages.length && !checks.length) errors.push('At least one stage needs a check.');
  const lastCheck = checks.reduce((m, i) => Math.max(m, i), -1);
  wf.stages.forEach((s, i) => {
    if (!s.pushes) return;
    const ok = wf.stages.some((g, gi) => g.kind === 'gate' && gi < i && gi > lastCheck);
    if (!ok) errors.push(`${label(s, i)} pushes, so it needs a gate before it and after every stage with a check.`);
  });

  // A jump into the spine must not fall through to a pushing stage without passing a push gate
  // (a gate after every check stage). Actions on a push gate itself may go anywhere.
  const index = new Map(wf.stages.map((s, i) => [s.id, i]));
  const isPushGate = (s, i) => s.kind === 'gate' && i > lastCheck;
  const pushing = wf.stages.map((s, i) => (s.pushes ? i : -1)).filter((i) => i >= 0);
  const unguarded = (t) => pushing.find((p) => p >= t && !wf.stages.some((g, gi) => isPushGate(g, gi) && gi >= t && gi < p));
  const reach = (target, what) => {
    const t = index.get(target);
    if (t === undefined) return;
    const p = unguarded(t);
    if (p === undefined) return;
    errors.push(p === t
      ? `${what} goes to '${target}', which pushes without passing a gate after every check.`
      : `${what} goes to '${target}', which reaches pushing stage '${wf.stages[p].id}' without passing a gate after every check.`);
  };
  wf.stages.forEach((s, i) => {
    if (s.kind !== 'gate' || isPushGate(s, i)) return;
    for (const a of s.actions) reach(a.goto, `Gate '${s.id}' action '${a.label}'`);
  });
  for (const key of ['afterFix', 'resumeAt']) {
    const t = index.get(loop[key]);
    const p = t === undefined ? undefined : unguarded(t);
    if (p !== undefined) errors.push(`The fix loop ${key} '${loop[key]}' reaches pushing stage '${wf.stages[p].id}' without passing a gate after every check.`);
  }
  return errors;
}
