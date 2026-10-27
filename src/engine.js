// Pure workflow engine on the graph: state in, state out. No I/O.
import { OUTCOMES, matchEdge, startNodes } from './workflow.js';

const ENDED = ['done', 'stopped'];
const fail = (error) => ({ ok: false, error });
const outEdges = (wf, id) => wf.edges.filter((e) => e.from === id);

// Runs one move on a copy of the state. `act` leaves nodes and enters new ones; the result lists both
// (step, check, gate and end nodes only: split and join are passed through).
function move(wf, state, act) {
  const nodes = new Map(wf.nodes.map((n) => [n.id, n]));
  const s = { ...state, active: [...state.active], joins: structuredClone(state.joins ?? {}) };
  const entered = [];
  const left = [];
  // Cancelled nodes: one entered during this same move was never really visited.
  const cancel = () => {
    for (const id of s.active) {
      const i = entered.indexOf(id);
      if (i >= 0) entered.splice(i, 1);
      else left.push(id);
    }
  };
  const leave = (id) => { s.active = s.active.filter((x) => x !== id); left.push(id); };

  function enter(id, via, note) {
    const n = nodes.get(id);
    if (!n || ENDED.includes(s.status)) return;
    if (n.type === 'split') {
      for (const e of outEdges(wf, id)) enter(e.to, e, note);
    } else if (n.type === 'join') {
      const arrived = [...new Set([...(Object.hasOwn(s.joins, id) ? s.joins[id] : []), via?.id])];
      if (wf.edges.every((e) => e.to !== id || arrived.includes(e.id))) {
        delete s.joins[id];
        const next = outEdges(wf, id)[0];
        if (next) enter(next.to, next, note);
      } else s.joins[id] = arrived;
    } else if (n.type === 'end') {
      cancel();
      Object.assign(s, { active: [], joins: {}, status: id === 'stopped' ? 'stopped' : 'done', ask: null });
      entered.push(id);
    } else if (n.type === 'gate' && id === wf.loop.decision) {
      cancel(); // a decision stops every parallel branch
      Object.assign(s, { active: [id], joins: {}, ask: note || n.ask });
      entered.push(id);
    } else {
      if (!s.active.includes(id)) s.active.push(id);
      if (n.type === 'gate') s.ask = n.ask;
      entered.push(id);
    }
  }

  act(s, enter, leave);
  if (!ENDED.includes(s.status)) {
    const order = new Map(wf.nodes.map((n, i) => [n.id, i]));
    s.active.sort((a, b) => order.get(a) - order.get(b));
    const waiting = s.active.some((id) => nodes.get(id)?.type === 'gate');
    s.status = waiting ? 'waiting' : 'active';
    if (!waiting) s.ask = null;
  }
  return { ok: true, state: s, entered, left };
}

export function startState(wf) {
  const blank = { active: [], joins: {}, round: 0, status: 'active', verdict: null, ask: null };
  return move(wf, blank, (s, enter) => enter(startNodes(wf)[0])).state;
}

export function stop(state) {
  return { ...state, active: [], joins: {}, status: 'stopped', ask: null };
}

export function validOutcomes(wf, id) {
  const edges = outEdges(wf, id);
  return OUTCOMES.filter((o) => matchEdge(edges, o));
}

export function completeStage(wf, state, { stage, outcome, note }) {
  if (ENDED.includes(state.status)) return fail(`Run is already ${state.status}.`);
  if (!OUTCOMES.includes(outcome)) return fail(`Unknown outcome '${outcome}'. Use one of: ${OUTCOMES.join(', ')}.`);
  if (!state.active.includes(stage)) return fail(`Stage '${stage}' is not active. Active: ${state.active.join(', ') || 'none'}.`);
  if (wf.nodes.find((n) => n.id === stage)?.type === 'gate') return fail(`Run is waiting on Ryan at '${stage}'; use respond.`);
  const edge = matchEdge(outEdges(wf, stage), outcome);
  if (!edge) return fail(`No edge from '${stage}' for outcome '${outcome}'. Valid outcomes: ${validOutcomes(wf, stage).join(', ') || 'none'}.`);

  return move(wf, state, (s, enter, leave) => {
    leave(stage);
    s.verdict = outcome;
    if (edge.fixRound && s.round + 1 > wf.loop.maxRounds) {
      return enter(wf.loop.decision, null, `${note || 'Checks failed'} (fix round limit ${wf.loop.maxRounds} reached)`);
    }
    if (edge.fixRound) s.round += 1;
    enter(edge.to, edge, note);
  });
}

export function respond(wf, state, { action, text }) {
  if (state.status !== 'waiting') return fail(`Run is not waiting on Ryan (status ${state.status}).`);
  const gate = wf.nodes.find((n) => n.type === 'gate' && state.active.includes(n.id));
  const actions = gate?.actions ?? [];
  const want = String(action ?? '').trim().toLowerCase();
  const hit = actions.find((a) => String(a.label).trim().toLowerCase() === want);
  if (!hit) return fail(`Unknown action '${action}'. Use one of: ${actions.map((a) => a.label).join(', ')}.`);
  const edge = wf.edges.find((e) => e.from === gate.id && e.on === hit.label);
  if (!edge) return fail(`Gate '${gate.id}' has no edge for action '${hit.label}'.`);

  const res = move(wf, state, (s, enter, leave) => {
    leave(gate.id);
    s.round = 0; // every answer starts the fix rounds again
    enter(edge.to, edge);
  });
  return { ...res, answer: { action: hit.label, text: text ?? '' } };
}

export function describeNode(wf, id, state) {
  const n = wf.nodes.find((x) => x.id === id);
  if (!n) return null;
  const out = { id: n.id, name: n.name, type: n.type, runner: n.runner, model: n.model, instructions: n.instructions };
  if (n.type === 'gate') {
    out.ask = state?.status === 'waiting' && state.active?.includes(id) && state.ask ? state.ask : n.ask;
    out.actions = n.actions.map(({ label }) => ({ label }));
    out.textField = n.textField;
  }
  return out;
}
