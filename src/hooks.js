// Claude hook events -> per-agent tracking. Never throws: every problem answers {}.
import path from 'node:path';
import { fileSize, readUsage, readMeta, subagentPath } from './transcripts.js';

// Tools a Claude session may still use on a run that was handed over to Codex.
const READ_TOOLS = new Set(['get_run', 'list_runs', 'get_workflow', 'log', 'respond']);
const ENDED = ['done', 'stopped'];
const LIVE = ['active', 'waiting'];
const TOKEN_READ_EVERY_MS = 5000;
const MAX_PENDING = 2000;

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const str = (v) => (typeof v === 'string' && v ? v : null);

function summarize(input) {
  if (!input || typeof input !== 'object') return '';
  const first = Object.values(input).find((v) => typeof v === 'string');
  return text(input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? first, 120);
}

const samePath = (a, b) => {
  if (!a || !b) return false;
  const x = path.resolve(a), y = path.resolve(b);
  return process.platform === 'win32' ? x.toLowerCase() === y.toLowerCase() : x === y;
};

// The short name of an agent-monitor MCP tool ('complete_stage'), whichever way the client spells it, else null.
const monitorTool = (name) => (typeof name === 'string' ? /^(?:mcp__agent-monitor__|agent-monitor[.:/])(\w+)$/.exec(name)?.[1] ?? null : null);

// An error time as ISO: epoch seconds or an ISO string, else null.
const isoTime = (v) => {
  const d = typeof v === 'number' && Number.isFinite(v) ? new Date(v * 1000) : typeof v === 'string' && v ? new Date(v) : null;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString() : null;
};

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

const stable = (v) => (v && typeof v === 'object'
  ? JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
  : String(v));

export function createHooks(store, { projectsDir, port, defer = setImmediate, clock = Date.now, onLimit } = {}) {
  // A command aimed at our own port on a loopback host: subagents must use the MCP tools instead.
  const selfApi = port ? new RegExp(`(?:127\\.\\d+\\.\\d+\\.\\d+|localhost|\\[::1\\]|0\\.0\\.0\\.0):${port}(?!\\d)`, 'i') : null;
  const pending = new Map(); // tool_use_id -> {sid, agentId, tool, key}
  const lastRead = new Map(); // agent id -> ms of the last transcript read

  function readTokens(agentId, overridePath) {
    const a = store.getAgent(agentId);
    if (!a || a.provider === 'codex') return; // Codex tokens come from its JSON events, not a transcript
    const file = overridePath || a.transcript_path;
    // A really different file is recounted from 0 and replaces the totals; the same file adds only what is new.
    const fresh = Boolean(overridePath) && !samePath(overridePath, a.transcript_path);
    const base = fresh ? { transcript_offset: 0, last_msg_id: null, input_tokens: 0, output_tokens: 0, cache_creation_tokens: 0, cache_read_tokens: 0 } : a;
    const u = readUsage({ file, root: projectsDir, offset: base.transcript_offset, lastMsgId: base.last_msg_id });
    const fields = {
      transcript_path: file, transcript_offset: u.offset, last_msg_id: u.lastMsgId,
      input_tokens: base.input_tokens + u.input, output_tokens: base.output_tokens + u.output,
      cache_creation_tokens: base.cache_creation_tokens + u.cacheCreation, cache_read_tokens: base.cache_read_tokens + u.cacheRead,
    };
    if (u.model) fields.model = u.model;
    if (!a.description && a.type !== 'main') {
      const meta = readMeta(file, projectsDir);
      if (meta) Object.assign(fields, { description: str(meta.description), model: fields.model ?? a.model ?? str(meta.model) });
    }
    store.updateAgent(agentId, fields);
  }

  // Which run and agent does this event belong to? null means "not ours": drop it.
  function resolve(p, provider) {
    const sid = p.session_id;
    const aid = str(p.agent_id);
    if (aid) {
      const known = store.getAgent(aid);
      if (known) return { run: store.getRun(known.run_id), agentId: aid };
    }
    // A Codex main thread is bound to its run through its agent row; later events and links never re-point it.
    if (provider === 'codex' && !aid) {
      const bound = store.getAgent(`codex:${sid}`);
      if (bound) { const run = store.getRun(bound.run_id); return run ? { run, agentId: bound.agent_id } : null; }
    }
    // An unknown Claude subagent joins the session's latest run that is not done, so a stopped run still denies it.
    // Codex events always adopt, so a stopped run denies every tool of its thread.
    const run = store.sessionRun(sid, { adoptStopped: provider === 'codex' || Boolean(aid) });
    if (!run) return null;
    if (run.status !== 'stopped') store.touchSession(sid, run.id);
    if (aid) {
      store.createAgent({ id: aid, runId: run.id, sessionId: sid, type: str(p.agent_type), provider, transcriptPath: provider === 'codex' ? null : subagentPath(aid, p.transcript_path, p.agent_transcript_path) });
      return { run, agentId: aid };
    }
    if (provider === 'codex') {
      const id = `codex:${sid}`;
      if (!store.getAgent(id)) store.createAgent({ id, runId: run.id, sessionId: sid, type: 'codex', provider });
      return { run, agentId: id };
    }
    const id = `main:${sid}`;
    const main = store.getAgent(id);
    if (!main) store.createAgent({ id, runId: run.id, sessionId: sid, type: 'main', transcriptPath: p.transcript_path, offset: fileSize(p.transcript_path, projectsDir) });
    else if (main.run_id !== run.id) store.updateAgent(id, { run_id: run.id });
    return { run, agentId: id };
  }

  // PostToolUse of an agent-monitor tool tells us which run this session or agent works on.
  function link(p, provider) {
    const tool = monitorTool(p.tool_name);
    let runId = null;
    if (tool === 'start_run') runId = /\bRUN ([a-z0-9][a-z0-9-]*)/.exec(JSON.stringify(p.tool_response ?? ''))?.[1];
    else runId = str(p.tool_input?.run);
    if (!runId || !store.getRun(runId)) return;
    const aid = str(p.agent_id);
    if (!aid) return provider === 'codex' ? undefined : store.linkSession(p.session_id, runId); // a Codex thread stays bound to its run
    const known = store.getAgent(aid);
    // A known agent keeps its run: a stopped run must not be escaped, and a subagent's start_run never moves it.
    if (known) {
      if (tool !== 'start_run' && store.getRun(known.run_id)?.status !== 'stopped') store.updateAgent(aid, { run_id: runId });
    } else store.createAgent({ id: aid, runId, sessionId: p.session_id, type: str(p.agent_type), provider, transcriptPath: provider === 'codex' ? null : subagentPath(aid, p.transcript_path, p.agent_transcript_path) });
    // The stages an agent reports on (token attribution).
    const stage = str(p.tool_input?.stage);
    const resp = JSON.stringify(p.tool_response ?? '');
    const failed = p.tool_response?.isError === true || resp.includes('ERROR:');
    if (tool === 'complete_stage' && stage && !failed) store.reportNode(aid, stage.slice(0, 80));
  }

  const commandOf = (input) => (Array.isArray(input?.command) ? input.command.join(' ') : String(input?.command ?? ''));
  const handedOver = (runId) => { const r = runId && store.getRun(runId); return r && r.provider === 'codex' && !ENDED.includes(r.status); };

  function handle(p, provider) {
    const ev = p.hook_event_name;
    const codex = provider === 'codex';
    const tool = monitorTool(p.tool_name);
    if (ev === 'PreToolUse') {
      if (codex) {
        // Codex never answers gates, and never reaches for the Agent Monitor API directly.
        if (tool === 'respond') return deny('Agent Monitor: only Ryan answers gates.');
        if (selfApi?.test(commandOf(p.tool_input))) return deny('Agent Monitor: the Agent Monitor API is off limits; use the agent-monitor MCP tools.');
      } else {
        // Only the main session relays Ryan's answers, whatever the run state and even when unlinked.
        if (tool === 'respond' && str(p.agent_id)) return deny("Agent Monitor: only the main session relays Ryan's answers.");
        if (selfApi && str(p.agent_id) && (p.tool_name === 'Bash' || p.tool_name === 'PowerShell') && selfApi.test(String(p.tool_input?.command ?? ''))) {
          return deny('Agent Monitor: subagents may not call the Agent Monitor API directly; use the mcp__agent-monitor__ tools.');
        }
        // Claude must not report on a run Codex took over, even from a session that is not linked.
        const target = str(p.tool_input?.run);
        if ((tool === 'complete_stage' || tool === 'log') && handedOver(target)) return deny(`Agent Monitor: run handed over to Codex (run ${target}). Stop work and report back.`);
      }
    }
    if (!codex && ev === 'UserPromptSubmit' && !str(p.agent_id) && typeof p.session_id === 'string') store.releaseSession(p.session_id);
    if (tool && ev === 'PostToolUse') link(p, provider);
    const who = resolve(p, provider);
    if (!who) return {};
    const { run, agentId } = who;
    if (!codex && typeof p.cwd === 'string' && (run.provider ?? 'claude') === 'claude') store.noteCwd(run.id, p.cwd);
    const act = (event, tool, summary) => store.addActivity(run.id, agentId, event, tool, summary);
    const agent = () => store.getAgent(agentId);

    switch (ev) {
      case 'PreToolUse': {
        if (!codex && run.provider === 'codex' && !ENDED.includes(run.status) && !READ_TOOLS.has(tool)) {
          return deny(`Agent Monitor: run handed over to Codex (run ${run.id}). Stop work and report back.`);
        }
        if ((codex || str(p.agent_id)) && run.status === 'stopped' && !tool) {
          return deny(`Agent Monitor: run ${run.id} was stopped by Ryan. Stop work and report back.`);
        }
        const summary = summarize(p.tool_input);
        store.updateAgent(agentId, { last_tool: text(p.tool_name, 80), last_summary: summary, tool_calls: agent().tool_calls + 1, last_activity_at: new Date().toISOString(), waiting_permission: 0 });
        act('tool', text(p.tool_name, 80), summary);
        if (p.tool_use_id) {
          if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
          pending.set(p.tool_use_id, { sid: p.session_id, agentId, tool: p.tool_name, key: stable(p.tool_input) });
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        pending.delete(p.tool_use_id);
        const fields = { waiting_permission: 0, last_activity_at: new Date().toISOString() };
        if (ev === 'PostToolUseFailure') {
          Object.assign(fields, { errors: agent().errors + 1, last_error: text(p.error, 200) });
          act('error', text(p.tool_name, 80), text(p.error, 120));
        }
        store.updateAgent(agentId, fields);
        if (clock() - (lastRead.get(agentId) ?? 0) >= TOKEN_READ_EVERY_MS) {
          lastRead.set(agentId, clock());
          defer(() => { try { readTokens(agentId); } catch { /* tokens are best effort */ } });
        }
        break;
      }
      case 'PermissionRequest': {
        let id = agentId;
        if (!str(p.agent_id)) {
          const key = stable(p.tool_input);
          for (const c of pending.values()) if (c.sid === p.session_id && c.tool === p.tool_name && c.key === key) id = c.agentId;
        }
        store.updateAgent(id, { waiting_permission: 1 });
        store.addActivity(run.id, id, 'permission', text(p.tool_name, 80), summarize(p.tool_input));
        break;
      }
      case 'SubagentStart':
        act('subagent_start', null, text(p.agent_type, 80));
        break;
      case 'SubagentStop': {
        store.updateAgent(agentId, { status: 'finished', finished_at: new Date().toISOString(), last_message: text(p.last_assistant_message, 300), waiting_permission: 0 });
        act('subagent_stop', null, text(p.last_assistant_message, 120));
        const file = str(p.agent_transcript_path) ?? undefined;
        defer(() => { try { readTokens(agentId, file); } catch { /* tokens are best effort */ } });
        break;
      }
      case 'Stop':
      case 'SessionEnd':
        act(ev === 'Stop' ? 'stop' : 'session_end', null, null);
        defer(() => { try { readTokens(agentId); } catch { /* tokens are best effort */ } });
        break;
      case 'StopFailure':
        act('stop_failure', null, text(p.error, 80));
        if (!codex && p.error === 'rate_limit' && LIVE.includes(run.status) && onLimit) {
          const info = { runId: run.id, at: new Date(clock()).toISOString(), resetsAt: isoTime(p.error_details?.resetsAt ?? p.error_details?.resets_at), source: 'stopfailure' };
          defer(() => { try { onLimit(info); } catch { /* the hand-off is best effort */ } });
        }
        break;
      case 'Notification':
        act('notification', null, text(p.message ?? p.title, 120));
        break;
      default:
    }
    return {};
  }

  return { handle: (p, provider = 'claude') => { try { return p && typeof p === 'object' ? handle(p, provider) : {}; } catch { return {}; } }, readTokens };
}
