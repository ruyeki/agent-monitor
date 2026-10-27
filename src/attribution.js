// Pure token attribution for one run: no I/O. The rules are written up in README.md ("How tokens are attributed").
import { priceFor, costOf } from './prices.js';

const RUNNER_WORDS = { verifier: 'verif', 'white-hat': 'white', reviewer: 'review', lead: 'lead' };
export const FIELDS = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'];

export const emptyAcc = () => ({ input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0, cost: 0, unpriced: 0 });

export function add(acc, m, price) {
  for (const f of FIELDS) acc[f] += m[f] ?? 0;
  const c = costOf(m, price);
  if (c == null) acc.unpriced += (m.input ?? 0) + (m.output ?? 0) + (m.cacheWrite ?? 0) + (m.cacheRead ?? 0);
  else acc.cost += c;
}

// cacheWrite includes the 1h part; Tokens exposes only the four counts, their total and the estimate.
export const toTokens = (a) => ({ input: a.input, output: a.output, cacheWrite: a.cacheWrite, cacheRead: a.cacheRead,
  total: a.input + a.output + a.cacheWrite + a.cacheRead, cost: a.cost, unpriced: a.unpriced });

// A lead's messages are split over the visits open at their time; every other subagent goes to one node.
export const isLead = (a) => /lead/i.test(a.type ?? '') || new Set(a.reportedNodes ?? []).size >= 2;

// Integer shares of each field over n parts, the remainder going to part 0.
function share(m, n, i) {
  const out = { ...m };
  for (const f of FIELDS) out[f] = Math.floor((m[f] ?? 0) / n) + (i === 0 ? (m[f] ?? 0) % n : 0);
  out.cacheWrite1h = Math.min(out.cacheWrite1h, out.cacheWrite);
  return out;
}

export function attributeRun({ run, workflow, visits = [], agents = [], messages = [], mainSessions = [], prices = [], now = Date.now() }) {
  const t = (v) => (typeof v === 'number' ? v : Date.parse(v));
  const nowMs = t(now);
  const start = t(run.createdAt);
  const end = run.endedAt ? t(run.endedAt) : nowMs;
  const nodeIds = workflow.nodes.map((n) => n.id);
  const nodeAcc = Object.fromEntries(nodeIds.map((id) => [id, emptyAcc()]));
  const main = emptyAcc();
  const mainBySession = new Map(mainSessions.map((sid) => [sid, emptyAcc()]));
  const unattributed = emptyAcc();
  const subs = agents.filter((a) => a.type !== 'main');
  const byId = new Map(subs.map((a) => [a.id, a]));
  const agentAcc = new Map(subs.map((a) => [a.id, emptyAcc()]));
  const nodeOf = (id) => workflow.nodes.find((n) => n.id === id);
  const accFor = (id) => nodeAcc[id] ?? (nodeAcc[id] = emptyAcc());

  const leads = new Set(subs.filter(isLead).map((a) => a.id));

  // The one node a non-lead subagent's tokens go to, or null.
  function homeNode(a) {
    const reported = [...new Set(a.reportedNodes ?? [])];
    if (reported.length === 1) return reported[0];
    const starts = a.startNodes ?? [];
    const text = `${a.description ?? ''} ${a.type ?? ''}`.toLowerCase();
    const inOrder = nodeIds.filter((id) => starts.includes(id)).map(nodeOf);
    const hit = inOrder.find((n) => [RUNNER_WORDS[n.runner], n.id, String(n.name ?? '').toLowerCase()].some((k) => k && text.includes(k)));
    if (hit) return hit.id;
    const workers = starts.filter((id) => nodeOf(id)?.runner === 'worker');
    if (workers.length === 1) return workers[0];
    return starts[0] ?? null;
  }
  const homes = new Map(subs.filter((a) => !leads.has(a.id)).map((a) => [a.id, homeNode(a)]));

  const windows = visits.map((v) => ({ node: v.node, from: t(v.enteredAt), to: v.leftAt ? t(v.leftAt) : nowMs }));

  for (const m of messages) {
    const price = priceFor(prices, m.model);
    const ts = t(m.ts);
    if (m.agentId == null) {
      const session = mainBySession.get(m.sessionId);
      if (session && ts >= start && ts <= end) { add(main, m, price); add(session, m, price); }
      continue;
    }
    const a = byId.get(m.agentId);
    if (!a) continue;
    add(agentAcc.get(a.id), m, price);
    if (!leads.has(a.id)) {
      add(homes.get(a.id) ? accFor(homes.get(a.id)) : unattributed, m, price);
      continue;
    }
    const open = windows.filter((w) => ts >= w.from && ts < w.to);
    if (!open.length) add(unattributed, m, price);
    else open.forEach((w, i) => add(accFor(w.node), share(m, open.length, i), price));
  }

  const nodes = Object.fromEntries(Object.entries(nodeAcc).map(([id, a]) => [id, toTokens(a)]));
  const total = emptyAcc();
  for (const a of [...Object.values(nodeAcc), main, unattributed]) {
    for (const f of [...FIELDS, 'cost', 'unpriced']) total[f] += a[f];
  }
  return {
    nodes, main: toTokens(main), mainBySession: Object.fromEntries([...mainBySession].map(([sid, a]) => [sid, toTokens(a)])), unattributed: toTokens(unattributed), total: toTokens(total),
    agents: Object.fromEntries(subs.map((a) => [a.id, { role: leads.has(a.id) ? 'lead' : 'subagent', node: homes.get(a.id) ?? null, tokens: toTokens(agentAcc.get(a.id)) }])),
  };
}
