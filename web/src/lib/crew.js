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
