// The run view's tool calls and "is this agent working" rules. Pure: nowMs is passed in, nothing reads the clock.
const ENDED = ['done', 'stopped'];
const STOPS = new Set(['stop', 'session_end', 'subagent_stop', 'stop_failure']);
const STALE_MS = 30 * 60 * 1000; // a run with no activity for this long has no running call
const WORKING_MS = 2 * 60 * 1000; // an agent with no running call counts as working for this long after its last activity
const MAX_CALLS = 10;

const ms = (iso) => {
  const t = typeof iso === 'string' ? Date.parse(iso) : NaN;
  return Number.isNaN(t) ? null : t;
};

// Tool-call rows of detail.activity (newest first), at most `limit`, each with a status:
// success / error from the recorded outcome, else running or unknown (no end recorded).
export function toolCalls(detail, nowMs = Date.now(), limit = MAX_CALLS) {
  const { run, agents = [], activity = [] } = detail ?? {};
  if (!Array.isArray(activity)) return [];
  const rows = activity.filter((r) => r && typeof r === 'object');
  const newestAt = ms(rows[0]?.at);
  const fresh = newestAt !== null && nowMs - newestAt < STALE_MS;
  const live = !!run && !ENDED.includes(run.status);
  const out = [];
  for (let i = 0; i < rows.length && out.length < limit; i++) {
    const r = rows[i];
    if (r.event !== 'tool') continue;
    const agent = agents.find((a) => a.id === r.agentId);
    const newer = rows.slice(0, i).filter((n) => n.agentId === r.agentId);
    let status = 'unknown';
    if (r.outcome === 'ok') status = 'success';
    else if (r.outcome === 'error') status = 'error';
    else if (live && fresh && agent?.status === 'running' && !newer.some((n) => STOPS.has(n.event)) && (r.toolUseId || !newer.some((n) => n.event === 'tool'))) status = 'running';
    const start = ms(r.at);
    const end = ms(r.endedAt);
    const err = status === 'error' && r.toolUseId ? rows.find((n) => n.event === 'error' && n.toolUseId === r.toolUseId) : null;
    out.push({
      id: r.id, tool: r.tool ?? '', summary: r.summary ?? '', agentId: r.agentId ?? null, agent: agent?.type ?? r.agentId ?? null,
      at: r.at, endedAt: r.endedAt ?? null, status,
      durationMs: start !== null && end !== null ? Math.max(0, end - start) : null,
      error: err?.summary || null,
    });
  }
  return out;
}

// The label for an agent's Thinking Loader pill, or null when the agent is not working.
// fallback = the run's stage label, used when no tool call is running.
export function pillLabel(detail, agent, nowMs, fallback) {
  const { run, activity = [] } = detail ?? {};
  if (!run || ENDED.includes(run.status) || agent?.status !== 'running' || agent.waitingPermission) return null;
  const newest = (Array.isArray(activity) ? activity : []).find((r) => r && r.agentId === agent.id);
  if (!newest || STOPS.has(newest.event)) return null;
  const call = toolCalls(detail, nowMs, Infinity).find((c) => c.agentId === agent.id && c.status === 'running');
  if (call) return call.tool || fallback;
  const last = ms(agent.lastActivityAt);
  return last !== null && nowMs - last < WORKING_MS ? fallback : null;
}
