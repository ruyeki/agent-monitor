// Workflow model: a graph of nodes and outcome-labelled edges, its defaults, the seed, the v1 conversion and validation.

export const OUTCOMES = ['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck'];
export const NODE_TYPES = ['step', 'check', 'gate', 'split', 'join', 'end'];
export const RUNNERS = ['main', 'lead', 'worker', 'verifier', 'white-hat', 'reviewer', 'custom'];
export const MODELS = ['inherit', 'haiku', 'sonnet', 'opus', 'fable'];

const ESCALATIONS = ['regression', 'env', 'stuck'];
const ALIAS = new Map([['pass', 'done'], ['done', 'pass'], ['fail', 'finding'], ['finding', 'fail']]);
const ID_RE = /^[a-z][a-z0-9_-]*$/;
const GAP = 220;
const DONE = 'When it is done, call complete_stage with the outcome.';
const FIX_TEXT = `Fix what the last check found. Make a root-cause change, not a patch over the symptom. ${DONE}`;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);
const dflt = (v, d) => (v === undefined ? d : v);
const edgeId = (from, to, on) => `${from}>${to}:${on}`;

// The edge an outcome follows: exact `on`, then its alias (pass/done, fail/finding), then '*'.
export function matchEdge(edges, on) {
  const alias = ALIAS.get(on);
  return edges.find((e) => e.on === on) ?? (alias && edges.find((e) => e.on === alias)) ?? edges.find((e) => e.on === '*') ?? null;
}

// Start candidates: nodes with no incoming edge, other than end and join nodes. A valid workflow has exactly one.
export function startNodes(wf) {
  const into = new Set(wf.edges.map((e) => e.to));
  return wf.nodes.filter((n) => !into.has(n.id) && n.type !== 'end' && n.type !== 'join').map((n) => n.id);
}

const node = (id, type, name, runner, model, instructions, x, y, extra = {}) => ({
  id, type, name, runner, model, instructions, pushes: false, position: { x, y }, ...extra,
});
const work = (id, type, name, runner, model, text, x, y, extra) => node(id, type, name, runner, model, `${text} ${DONE}`, x, y, extra);
const gate = (id, name, ask, labels, x, y) => node(id, 'gate', name, 'main', 'inherit', '', x, y, {
  ask, actions: labels.map((label) => ({ label })), textField: true,
});
const bare = (id, type, name, x, y) => node(id, type, name, 'main', 'inherit', '', x, y);
const edge = (from, to, on, fixRound = false) => ({ id: edgeId(from, to, on), from, to, on, fixRound });

export function seedWorkflow() {
  return {
    nodes: [
      work('frame', 'step', 'Frame', 'main', 'inherit',
        'Investigate the task read-only and show Ryan the problem card. Do not agree a spec here: Gate 1 asks for his solution.', 0, 0),
      gate('gate1', 'Gate 1: solution', "What's your solution?", ['Agree spec', 'Stop run'], 220, 0),
      node('plan', 'step', 'Plan', 'lead', 'opus',
        `After Gate 1, write the agreed spec into the task and spawn the lead with RUN: <id> in its brief. Write one fact sheet with the files, contracts and gotchas. Plan the work in small pieces. Agents read the fact sheet instead of exploring again. ${DONE} complete_stage returns implement and prep: run both together in the foreground, then report each with complete_stage.`, 440, 0),
      bare('split', 'split', 'Parallel', 660, 0),
      work('implement', 'step', 'Implement', 'worker', 'sonnet',
        'The worker builds exactly the spec in its scope and never commits. It runs in the foreground, in parallel with the verifier prep.', 880, -100),
      work('prep', 'step', 'Verifier prep', 'verifier', 'sonnet',
        'The verifier writes the baseline tests and the hidden holdout tests from the acceptance criteria. It never edits product code. It runs in the foreground, in parallel with the worker.', 880, 100),
      bare('join', 'join', 'Join', 1100, 0),
      work('verify', 'check', 'Verify', 'verifier', 'sonnet',
        'Run the targeted tests, not the full suite. Report pass, or fail with the failing behaviour. Report a regression as regression. Never edit product code.', 1320, 0),
      node('fix', 'step', 'Fix', 'worker', 'sonnet', FIX_TEXT, 1540, 220),
      work('review', 'check', 'Review', 'lead', 'inherit',
        'Read the diff against the spec. Run the ponytail debloat pass and keep behaviour the same. Report any real problem as a finding. Never remove validation, error handling, security checks or tests.', 1540, 0),
      work('whitehat', 'check', 'White-hat', 'white-hat', 'sonnet',
        'Attack the diff: injection, path traversal, missing access checks, resource abuse, secrets in logs. Report only findings with a proven attack path. Skip it for copy, CSS or docs changes.', 1760, 0),
      work('commit', 'step', 'Commit', 'lead', 'inherit',
        'Move the verifier tests into the repo test folder. Commit locally with a message that explains why. Never push and never commit secrets.', 1980, 0),
      work('report', 'step', 'Report', 'lead', 'inherit',
        'Check each acceptance criterion against evidence. Write the six-part report: what was done, how it works, code changes, verification, review rounds, open concerns. Never claim a test passed unless it ran.', 2200, 0),
      gate('gate2', 'Gate 2: accept', 'Accept, push and open the PR?', ['Accept', 'Request changes', 'Stop run'], 2420, 0),
      work('pr', 'step', 'Open PR', 'main', 'inherit',
        'Push the branch, and only that branch. Open a draft PR with a clear title, the summary, the verification results and the open concerns. Put the PR link in the note.', 2640, 0, { pushes: true }),
      bare('done', 'end', 'Done', 2860, 0),
      gate('decision', 'Decision', 'Decision needed', ['Resume', 'Stop run'], 1100, 360),
      bare('stopped', 'end', 'Stopped', 2420, 360),
    ],
    edges: [
      edge('frame', 'gate1', 'done'),
      edge('gate1', 'plan', 'Agree spec'), edge('gate1', 'stopped', 'Stop run'),
      edge('plan', 'split', 'done'),
      edge('split', 'implement', '*'), edge('split', 'prep', '*'),
      edge('implement', 'join', 'done'), edge('prep', 'join', 'done'),
      edge('join', 'verify', '*'),
      edge('verify', 'review', 'pass'), edge('verify', 'fix', 'fail', true),
      ...ESCALATIONS.map((o) => edge('verify', 'decision', o)),
      edge('fix', 'verify', 'done'),
      edge('review', 'whitehat', 'pass'), edge('review', 'fix', 'finding', true),
      edge('whitehat', 'commit', 'pass'), edge('whitehat', 'fix', 'finding', true),
      edge('commit', 'report', 'done'), edge('report', 'gate2', 'done'),
      edge('gate2', 'pr', 'Accept'), edge('gate2', 'plan', 'Request changes'), edge('gate2', 'stopped', 'Stop run'),
      edge('pr', 'done', 'done'),
      edge('decision', 'plan', 'Resume'), edge('decision', 'stopped', 'Stop run'),
    ],
    loop: { maxRounds: 5, decision: 'decision' },
  };
}

// Converts a v1 spine workflow into the graph that behaves the same way.
export function fromSpine(input) {
  const src = isObj(input) ? input : {};
  const stages = (Array.isArray(src.stages) ? src.stages : []).filter(isObj);
  const l = isObj(src.loop) ? src.loop : {};
  const loop = {
    maxRounds: dflt(l.maxRounds, 5), fixRunner: dflt(l.fixRunner, 'worker'), fixModel: dflt(l.fixModel, 'sonnet'),
    afterFix: dflt(l.afterFix, 'verify'), resumeAt: dflt(l.resumeAt, 'plan'),
  };
  const n = stages.length;
  const next = (i) => stages[i + 1]?.id ?? 'done';
  const nodes = [];
  const edges = [];
  stages.forEach((s, i) => {
    const isGate = s.kind === 'gate';
    const check = isObj(s.check);
    const instructions = typeof s.instructions === 'string' ? s.instructions : '';
    const out = node(s.id, isGate ? 'gate' : check ? 'check' : 'step', s.name, s.runner ?? (isGate ? 'main' : undefined),
      s.model ?? 'inherit', instructions, i * GAP, 0, { pushes: s.pushes === true });
    if (isGate) {
      const actions = (Array.isArray(s.actions) ? s.actions : []).filter(isObj);
      Object.assign(out, { ask: typeof s.ask === 'string' ? s.ask : '', actions: actions.map((a) => ({ label: a.label })), textField: s.textField !== false });
      for (const a of actions) edges.push(edge(s.id, a.goto === 'next' ? next(i) : a.goto === 'stop' ? 'stopped' : a.goto, a.label));
    } else {
      edges.push(edge(s.id, next(i), 'pass'));
      const onFail = check ? s.check.onFail ?? 'fix' : 'decision';
      if (onFail === 'continue') edges.push(edge(s.id, next(i), 'fail'));
      else if (onFail === 'decision') edges.push(edge(s.id, 'decision', 'fail'));
      else edges.push(edge(s.id, 'fix', 'fail', true));
      for (const o of ESCALATIONS) edges.push(edge(s.id, 'decision', o));
    }
    nodes.push(out);
  });
  nodes.push(
    node('fix', 'step', 'Fix', loop.fixRunner, loop.fixModel, FIX_TEXT, GAP, 190),
    gate('decision', 'Decision', 'Decision needed', ['Resume', 'Stop run'], 550, 190),
    bare('done', 'end', 'Done', n * GAP, 0),
    bare('stopped', 'end', 'Stopped', Math.max(n - 1, 3) * GAP, 190),
  );
  edges.push(edge('fix', loop.afterFix, 'pass'));
  for (const o of ['fail', ...ESCALATIONS]) edges.push(edge('fix', 'decision', o));
  edges.push(edge('decision', loop.resumeAt, 'Resume'), edge('decision', 'stopped', 'Stop run'));
  return normalizeWorkflow({ nodes, edges, loop: { maxRounds: loop.maxRounds, decision: 'decision' } });
}

const position = (p) => (isObj(p) && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : { x: 0, y: 0 });

// Fills defaults. Never invents ids, names or runners, so validation can still catch those.
export function normalizeWorkflow(wf) {
  const src = isObj(wf) ? wf : {};
  if (Array.isArray(src.stages) && !Array.isArray(src.nodes)) return fromSpine(src);
  const loop = isObj(src.loop) ? src.loop : {};
  const nodes = (Array.isArray(src.nodes) ? src.nodes : []).filter(isObj).map((n) => {
    const out = {
      id: n.id, type: dflt(n.type, 'step'), name: n.name, runner: n.runner, model: dflt(n.model, 'inherit'),
      instructions: typeof n.instructions === 'string' ? n.instructions : '', pushes: n.pushes === true, position: position(n.position),
    };
    if (out.type === 'gate') {
      out.ask = typeof n.ask === 'string' ? n.ask : '';
      out.actions = (Array.isArray(n.actions) ? n.actions : []).filter(isObj).map((a) => ({ label: a.label }));
      out.textField = n.textField !== false;
    }
    return out;
  });
  const edges = (Array.isArray(src.edges) ? src.edges : []).filter(isObj)
    .map((e) => ({ id: e.id, from: e.from, to: e.to, on: e.on, fixRound: e.fixRound === true }));
  // A default fills only a missing key; null or a wrong type is kept so validation reports it.
  return { nodes, edges, loop: { maxRounds: dflt(loop.maxRounds, 5), decision: dflt(loop.decision, 'decision') } };
}

// Every node reachable from `from` along `next`, iteratively (drafts can be large).
function reach(from, next) {
  const seen = new Set(from);
  const todo = [...from];
  while (todo.length) for (const id of next(todo.pop())) if (!seen.has(id)) { seen.add(id); todo.push(id); }
  return seen;
}

export function validateWorkflow(input) {
  const wf = normalizeWorkflow(input);
  const errors = [];
  const err = (message, ref = {}) => errors.push({ message, ...ref });
  const byId = new Map();
  if (!wf.nodes.length) err('The workflow needs at least one node.');

  // 1. Nodes and edges on their own.
  wf.nodes.forEach((n, i) => {
    const named = typeof n.id === 'string' && n.id !== '';
    const who = named ? `Node '${n.id}'` : `Node number ${i + 1}`;
    const ref = named ? { node: n.id } : {};
    if (!named || !n.id.trim()) err(`${who} has no id.`, ref);
    else if (!ID_RE.test(n.id)) err(`${who} has an invalid id. Use lowercase letters, digits, - and _, starting with a letter.`, ref);
    else if (byId.has(n.id)) err(`${who} has an id that another node already uses.`, ref);
    if (named && !byId.has(n.id)) byId.set(n.id, n);
    if (typeof n.name !== 'string' || !n.name.trim()) err(`${who} has no name.`, ref);
    if (!NODE_TYPES.includes(n.type)) err(`${who} has an unknown type '${n.type}'.`, ref);
    if (n.type === 'step' || n.type === 'check') {
      if (!RUNNERS.includes(n.runner)) err(`${who} has an unknown runner '${n.runner}'.`, ref);
      if (!MODELS.includes(n.model)) err(`${who} has an unknown model '${n.model}'.`, ref);
    }
    if (n.type === 'gate') {
      if (!n.ask.trim()) err(`${who} is a gate and needs a question to ask.`, ref);
      if (n.actions.length < 1 || n.actions.length > 10) err(`${who} is a gate and needs from 1 to 10 actions.`, ref);
      const labels = new Set();
      for (const a of n.actions) {
        if (typeof a.label !== 'string' || !a.label.trim()) err(`${who} has an action with no label.`, ref);
        else if (labels.has(a.label.trim().toLowerCase())) err(`${who} has two actions labelled '${a.label}'.`, ref);
        else labels.add(a.label.trim().toLowerCase());
      }
    }
  });
  const edgeIds = new Set();
  const edges = [];
  wf.edges.forEach((e, i) => {
    const named = typeof e.id === 'string' && e.id.trim() !== '';
    const who = named ? `Edge '${e.id}'` : `Edge number ${i + 1}`;
    const ref = named ? { edge: e.id } : {};
    if (!named) err(`${who} has no id.`, ref);
    else if (edgeIds.has(e.id)) err(`${who} has an id that another edge already uses.`, ref);
    edgeIds.add(e.id);
    if (!byId.has(e.from)) err(`${who} starts at '${e.from}', which is not a node.`, ref);
    if (!byId.has(e.to)) err(`${who} goes to '${e.to}', which is not a node.`, ref);
    if (byId.has(e.from) && byId.has(e.to)) edges.push(e);
  });
  const out = new Map([...byId.keys()].map((id) => [id, []]));
  const inc = new Map([...byId.keys()].map((id) => [id, []]));
  for (const e of edges) { out.get(e.from).push(e); inc.get(e.to).push(e); }

  // 2 and 3. What each node's edges may say, and which edges it needs.
  for (const n of byId.values()) {
    const outs = out.get(n.id);
    const ref = { node: n.id };
    const ons = new Set();
    for (const e of outs) {
      const eref = { edge: e.id, node: n.id };
      if (n.type === 'end') err(`Edge '${e.id}' leaves end node '${n.id}', which cannot have outgoing edges.`, eref);
      else if ((n.type === 'step' || n.type === 'check') && !OUTCOMES.includes(e.on) && e.on !== '*') err(`Edge '${e.id}' needs an outcome (${OUTCOMES.join(', ')}) or '*', not '${e.on}'.`, eref);
      else if (n.type === 'gate' && !n.actions.some((a) => a.label === e.on)) err(`Edge '${e.id}' from gate '${n.id}' must use one of its action labels, not '${e.on}'.`, eref);
      else if ((n.type === 'split' || n.type === 'join') && e.on !== '*') err(`Edge '${e.id}' from ${n.type} '${n.id}' must use '*'.`, eref);
      else if (n.type !== 'split' && ons.has(e.on)) err(`Node '${n.id}' has two edges for '${e.on}'.`, eref);
      ons.add(e.on);
    }
    if ((n.type === 'step' || n.type === 'check') && !matchEdge(outs, 'pass')) err(`Node '${n.id}' needs an edge for success (pass or done) or '*'.`, ref);
    if (n.type === 'check' && !matchEdge(outs, 'fail')) err(`Check '${n.id}' needs an edge for failure (fail or finding) or '*'.`, ref);
    if (n.type === 'gate') {
      for (const a of n.actions) {
        if (typeof a.label === 'string' && outs.filter((e) => e.on === a.label).length !== 1) err(`Gate '${n.id}' action '${a.label}' needs exactly one edge.`, ref);
      }
    }
    if (n.type === 'split' && (outs.length < 2 || new Set(outs.map((e) => e.to)).size !== outs.length)) err(`Split '${n.id}' needs at least two outgoing edges to different nodes.`, ref);
    if (n.type === 'join' && inc.get(n.id).length < 2) err(`Join '${n.id}' needs at least two incoming edges.`, ref);
    if (n.type === 'join' && outs.length !== 1) err(`Join '${n.id}' needs exactly one outgoing edge.`, ref);
  }

  // 4. One start; everything reachable from it; an end reachable from everything.
  const starts = startNodes({ nodes: [...byId.values()], edges });
  if (byId.size && !starts.length) err('The workflow needs a start node: one node with no incoming edges.');
  if (starts.length > 1) for (const id of starts) err(`Node '${id}' has no incoming edges, but a workflow has only one start node.`, { node: id });
  const start = starts.length === 1 ? starts[0] : null;
  if (start) {
    const seen = reach([start], (id) => out.get(id).map((e) => e.to));
    for (const id of byId.keys()) if (!seen.has(id)) err(`Node '${id}' cannot be reached from the start node '${start}'.`, { node: id });
  }
  const ends = [...byId.values()].filter((n) => n.type === 'end').map((n) => n.id);
  if (byId.size && !ends.length) err('The workflow needs at least one end node.');
  if (ends.length) {
    const seen = reach(ends, (id) => inc.get(id).map((e) => e.from));
    for (const id of byId.keys()) if (!seen.has(id)) err(`Node '${id}' cannot reach an end node.`, { node: id });
  }

  // 5. Balanced split/join. A branch walks along success edges, jumping over nested split/join pairs.
  const type = (id) => byId.get(id).type;
  const matched = new Map(); // split -> its join, or null
  // Where a branch walk ends: { join } when it reaches one, { gate } when a gate stops it, else {}.
  function firstJoin(from) {
    const seen = new Set();
    for (let cur = from; cur && !seen.has(cur); ) {
      seen.add(cur);
      if (type(cur) === 'join') return { join: cur };
      if (type(cur) === 'gate') return { gate: cur };
      if (type(cur) === 'split') {
        const j = joinOf(cur);
        cur = j && out.get(j)[0]?.to;
      } else if (type(cur) === 'step' || type(cur) === 'check') cur = matchEdge(out.get(cur), 'pass')?.to;
      else return {};
    }
    return {};
  }
  function joinOf(split) {
    if (!matched.has(split)) {
      matched.set(split, null); // a cycle back into this split finds no join
      const js = out.get(split).map((e) => firstJoin(e.to).join);
      matched.set(split, js.length >= 2 && js[0] && js.every((j) => j === js[0]) ? js[0] : null);
    }
    return matched.get(split);
  }
  const inBranch = (gate, split) => `Gate '${gate}' sits inside a parallel branch of split '${split}'; gates can't sit inside parallel branches.`;
  const joinedBy = new Map();
  for (const s of byId.values()) {
    if (s.type !== 'split' || out.get(s.id).length < 2) continue;
    const ref = { node: s.id };
    const firsts = out.get(s.id).map((e) => e.to);
    const walks = firsts.map(firstJoin);
    const js = walks.map((w) => w.join);
    const gate = walks.find((w) => w.gate)?.gate;
    if (gate) { err(inBranch(gate, s.id), { node: gate }); continue; }
    if (js.some((j) => !j)) { err(`Split '${s.id}' has a branch that never reaches a join.`, ref); continue; }
    if (new Set(js).size > 1) { err(`Split '${s.id}' has branches that meet at different joins (${[...new Set(js)].join(', ')}).`, ref); continue; }
    const join = js[0];
    joinedBy.set(join, [...(joinedBy.get(join) ?? []), s.id]);
    const boundary = (id) => id === join || id === wf.loop.decision || type(id) === 'end';
    const regions = firsts.map((f) => (boundary(f) ? new Set() : reach([f], (id) => out.get(id).map((e) => e.to).filter((t) => !boundary(t)))));
    const owner = new Map();
    regions.forEach((region, i) => {
      for (const id of region) {
        if (owner.has(id) && owner.get(id) !== i) err(`Split '${s.id}' has branches that share node '${id}'.`, { node: id });
        owner.set(id, i);
        if (id === s.id) { err(`A branch of split '${s.id}' loops back to the split.`, ref); continue; }
        if (type(id) === 'gate') err(inBranch(id, s.id), { node: id });
        for (const e of inc.get(id)) {
          if (e.from !== s.id && !region.has(e.from)) err(`Edge '${e.id}' enters a parallel branch of split '${s.id}' from outside it.`, { edge: e.id });
        }
      }
    });
    const arrivals = regions.map((region, i) => inc.get(join).filter((e) => region.has(e.from) || (e.from === s.id && firsts[i] === join)).length);
    if (inc.get(join).length !== regions.length || arrivals.some((a) => a !== 1)) {
      err(`Join '${join}' needs exactly one incoming edge from each branch of split '${s.id}'.`, { node: join });
    }
  }
  for (const j of byId.values()) {
    if (j.type !== 'join') continue;
    const by = joinedBy.get(j.id) ?? [];
    if (!by.length) err(`Join '${j.id}' is not matched by any split.`, { node: j.id });
    if (by.length > 1) err(`Join '${j.id}' is matched by more than one split (${by.join(', ')}).`, { node: j.id });
  }

  // 6. Push rule: walk (node, phase) states. Phase 0 = no check yet, 1 = a check since the last gate, 2 = a gate after the last check.
  if (start) {
    const seen = new Set();
    const todo = [];
    const bad = new Set();
    const visit = (id, phase) => {
      const p = type(id) === 'check' ? 1 : type(id) === 'gate' && phase === 1 ? 2 : phase;
      if (byId.get(id).pushes && p !== 2) bad.add(id);
      if (!seen.has(`${p}:${id}`)) { seen.add(`${p}:${id}`); todo.push([id, p]); }
    };
    visit(start, 0);
    while (todo.length) {
      const [id, p] = todo.pop();
      for (const e of out.get(id)) visit(e.to, p);
    }
    for (const id of bad) err(`Node '${id}' pushes, but a path reaches it without a gate after its last check.`, { node: id });
  }

  // 7. Loop settings.
  const { loop } = wf;
  if (!Number.isInteger(loop.maxRounds) || loop.maxRounds < 1 || loop.maxRounds > 10) err('The fix loop needs maxRounds as a whole number from 1 to 10.');
  if (wf.edges.some((e) => e.fixRound) && byId.get(loop.decision)?.type !== 'gate') {
    err(`Fix-round edges need loop.decision '${loop.decision}' to be a gate.`, byId.has(loop.decision) ? { node: loop.decision } : {});
  }
  return errors;
}
