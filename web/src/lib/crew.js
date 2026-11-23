// Agent roles, names, avatars and model labels (contract C10), plus "who is working on what" for a run. Pure: the
// clock is passed in.
import { pillLabel, toolCalls } from './toolCalls.js';

// Description words first: the verifier and the white-hat run as `sonnet-engineer`, so the type alone would hide them.
// The word that comes first wins: "Lead: plan; review each piece" is a lead, "Verifier for the lead's plan" a verifier.
const DESC_ROLES = [
  [/\bverif/i, 'verifier'],
  [/\bwhite\b|\bwhite-?hat/i, 'white-hat'],
  [/\breview/i, 'reviewer'],
  [/\blead\b/i, 'lead'],
];
const TYPE_ROLES = [
  [/lead/, 'lead'],
  [/verif/, 'verifier'],
  [/white/, 'white-hat'],
  [/review/, 'reviewer'],
  [/engineer|worker/, 'engineer'],
];

export function roleOf(agent) {
  const type = String(agent?.type ?? '').toLowerCase();
  if (type === 'main' || String(agent?.id ?? '').startsWith('main:')) return 'main';
  const desc = String(agent?.description ?? '');
  const hits = DESC_ROLES.map(([re, role]) => [desc.search(re), role]).filter(([at]) => at >= 0);
  if (hits.length) return hits.sort((x, y) => x[0] - y[0])[0][1];
  for (const [re, role] of TYPE_ROLES) if (re.test(type)) return role;
  if (type === 'codex' || agent?.provider === 'codex') return 'codex';
  return 'other';
}

const AVATARS = { main: ['M', 'main'], lead: ['L', 'lead'], engineer: ['E', 'eng'], verifier: ['V', 'ver'], 'white-hat': ['W', 'wh'], reviewer: ['R', 'other'], codex: ['C', 'other'] };
const RANK = ['main', 'lead', 'engineer', 'verifier', 'white-hat', 'reviewer', 'codex', 'other'];

// {role, letter, cls}: cls is one of main / lead / eng / ver / wh / other (the avatar colour).
export function avatarOf(agent) {
  const role = roleOf(agent);
  const [letter, cls] = AVATARS[role] ?? [(/[a-z]/i.exec(String(agent?.type ?? ''))?.[0] ?? '?').toUpperCase(), 'other'];
  return { role, letter, cls };
}

// The name shown for an agent: "Main session", the role when the type hides it (a verifier running as sonnet-engineer), else the type.
export function agentName(agent) {
  const role = roleOf(agent);
  if (role === 'main') return 'Main session';
  const type = String(agent?.type ?? '');
  const word = { verifier: 'verif', 'white-hat': 'white', reviewer: 'review', lead: 'lead' }[role];
  if (word && !type.toLowerCase().includes(word)) return role;
  return type || 'agent';
}

// Agents in avatar order: main, lead, engineers, verifier, white-hat, the rest; ties keep their order.
export function sortCrew(agents) {
  const list = Array.isArray(agents) ? agents.filter((a) => a && typeof a === 'object') : [];
  return list.map((a, i) => [RANK.indexOf(roleOf(a)), i, a]).sort((x, y) => x[0] - y[0] || x[1] - y[1]).map((x) => x[2]);
}

// "claude-opus-5-5" -> "Opus 5.5"; "claude-sonnet-4-20250514" -> "Sonnet 4"; "opus" -> "Opus"; anything else as is.
export function modelLabel(model) {
  const m = /^(?:claude-)?(fable|opus|sonnet|haiku)(?:-(\d+)(?:-(\d{1,2})(?!\d))?)?/i.exec(String(model ?? ''));
  if (!m) return model ? String(model) : 'model unknown';
  const family = m[1][0].toUpperCase() + m[1].slice(1).toLowerCase();
  return m[2] && m[2].length < 3 ? `${family} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : family;
}

const callText = (tool, summary) => [tool, summary].filter(Boolean).join(' ').trim();

// What one running agent is doing now: its running tool call ("Edit web/src/Monitor.jsx"), its last tool while it
// still counts as working, or null when it is not working.
export function agentCall(detail, agent, nowMs) {
  if (!agent || agent.status !== 'running') return null;
  const call = toolCalls(detail, nowMs, Infinity).find((c) => c.agentId === agent.id && c.status === 'running');
  if (call) return callText(call.tool, call.summary) || 'working';
  return pillLabel(detail, agent, nowMs, 'working') ? callText(agent.lastTool, agent.lastSummary) || 'working' : null;
}

// The run's live activity for a row or card: {agent, name, call} of the agent with the newest running call, else of
// the most recently active working agent; null when nobody works.
export function nowWorking(detail, nowMs) {
  const agents = (Array.isArray(detail?.agents) ? detail.agents : []).filter((a) => a && a.status === 'running');
  if (!agents.length) return null;
  const call = toolCalls(detail, nowMs, Infinity).find((c) => c.status === 'running' && agents.some((a) => a.id === c.agentId));
  const ordered = call ? [agents.find((a) => a.id === call.agentId)] : [...agents].sort((a, b) => (Date.parse(b.lastActivityAt) || 0) - (Date.parse(a.lastActivityAt) || 0));
  for (const a of ordered) {
    const text = agentCall(detail, a, nowMs);
    if (text) return { agent: a, name: agentName(a), call: text };
  }
  return null;
}

// The run's agents as a tree: main session -> lead -> helpers (contract C7). Pure.
// A parent counts as known only when `parentId` names another agent of this run. An agent whose parent is unknown (or
// would make a loop) is placed under the lead, or under the first main session when there is no lead (or the agent is
// the lead); it gets no edge, so the picture never claims a link the server did not record.
// Returns { roots, levels, edges, nodes }: node = { id, agent, parentId (where it sits), edge (the known parent, else
// null), depth, children }; levels[n] = the nodes at depth n; edges = [{ from, to }] for known parents only.
export function crewTree(agents) {
  const crew = sortCrew(agents).filter((a) => a.id != null);
  const byId = new Map(crew.map((a) => [a.id, a]));
  const lead = crew.find((a) => roleOf(a) === 'lead');
  const main = crew.find((a) => roleOf(a) === 'main');
  const known = (a) => (a.parentId != null && a.parentId !== a.id && byId.has(a.parentId) ? a.parentId : null);
  const fallback = (a) => {
    const role = roleOf(a);
    if (role === 'main') return null;
    if (lead && lead !== a) return lead.id;
    return main && main !== a ? main.id : null;
  };
  const at = new Map(crew.map((a) => [a.id, known(a) ?? fallback(a)]));
  const edge = new Map(crew.map((a) => [a.id, known(a)]));
  // Break loops (a's parent chain comes back to a): that agent becomes a root with no edge.
  for (const a of crew) {
    const seen = new Set([a.id]);
    for (let p = at.get(a.id); p != null; p = at.get(p)) {
      if (seen.has(p)) {
        if (p === a.id) {
          at.set(a.id, null);
          edge.set(a.id, null);
        }
        break;
      }
      seen.add(p);
    }
  }
  const nodes = crew.map((a) => ({ id: a.id, agent: a, parentId: at.get(a.id), edge: edge.get(a.id), depth: 0, children: [] }));
  const node = new Map(nodes.map((n) => [n.id, n]));
  const roots = [];
  for (const n of nodes) (n.parentId == null ? roots : node.get(n.parentId).children).push(n);
  // Children with a recorded link come first, so the connector bar over them has no gaps.
  const linked = (n) => (n.edge != null ? 0 : 1);
  for (const n of [{ children: roots }, ...nodes]) n.children.sort((x, y) => linked(x) - linked(y)); // stable
  const levels = [];
  const walk = (list, depth) => {
    for (const n of list) {
      n.depth = depth;
      (levels[depth] ??= []).push(n);
      walk(n.children, depth + 1);
    }
  };
  walk(roots, 0);
  const edges = nodes.filter((n) => n.edge != null).map((n) => ({ from: n.edge, to: n.id }));
  return { roots, levels, edges, nodes };
}

// Context window use as a whole percent, or null when the server has no reading yet (never a made-up 0).
export function contextPct(agent) {
  const c = agent?.context;
  if (c == null || c.pct == null || c.pct === '') return null;
  const n = Number(c.pct);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : null;
}
