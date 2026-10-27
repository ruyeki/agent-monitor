// Claude hook events -> per-agent tracking. Never throws: every problem answers {}.
import path from 'node:path';
import { fileSize, readUsage, readMeta, subagentPath } from './transcripts.js';

const MCP_PREFIX = 'mcp__agent-monitor__';
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

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

const stable = (v) => (v && typeof v === 'object'
  ? JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x)
    ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x))
  : String(v));

export function createHooks(store, { projectsDir, port, defer = setImmediate, clock = Date.now } = {}) {
  // A command aimed at our own port on a loopback host: subagents must use the MCP tools instead.
  const selfApi = port ? new RegExp(`(?:127\\.\\d+\\.\\d+\\.\\d+|localhost|\\[::1\\]|0\\.0\\.0\\.0):${port}(?!\\d)`, 'i') : null;
  const pending = new Map(); // tool_use_id -> {sid, agentId, tool, key}
  const lastRead = new Map(); // agent id -> ms of the last transcript read

  function readTokens(agentId, overridePath) {
    const a = store.getAgent(agentId);
    if (!a) return;
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
  function resolve(p) {
    const sid = p.session_id;
    const aid = str(p.agent_id);
    if (aid) {
      const known = store.getAgent(aid);
      if (known) return { run: store.getRun(known.run_id), agentId: aid };
    }
    // An unknown subagent joins the session's latest run that is not done, so a stopped run still denies it.
    const run = store.sessionRun(sid, { adoptStopped: Boolean(aid) });
    if (!run) return null;
    if (run.status !== 'stopped') store.touchSession(sid, run.id);
    if (aid) {
      store.createAgent({ id: aid, runId: run.id, sessionId: sid, type: str(p.agent_type), transcriptPath: subagentPath(aid, p.transcript_path, p.agent_transcript_path) });
      return { run, agentId: aid };
    }
    const id = `main:${sid}`;
    const main = store.getAgent(id);
    if (!main) store.createAgent({ id, runId: run.id, sessionId: sid, type: 'main', transcriptPath: p.transcript_path, offset: fileSize(p.transcript_path, projectsDir) });
    else if (main.run_id !== run.id) store.updateAgent(id, { run_id: run.id });
    return { run, agentId: id };
  }

  // PostToolUse of an agent-monitor tool tells us which run this session or agent works on.
  function link(p) {
    const tool = p.tool_name;
    let runId = null;
    if (tool === `${MCP_PREFIX}start_run`) runId = /\bRUN ([a-z0-9][a-z0-9-]*)/.exec(JSON.stringify(p.tool_response ?? ''))?.[1];
    else runId = str(p.tool_input?.run);
    if (!runId || !store.getRun(runId)) return;
    const aid = str(p.agent_id);
    if (!aid) return store.linkSession(p.session_id, runId);
    const known = store.getAgent(aid);
    // A known agent keeps its run: a stopped run must not be escaped, and a subagent's start_run never moves it.
    if (known) {
      if (tool !== `${MCP_PREFIX}start_run` && store.getRun(known.run_id)?.status !== 'stopped') store.updateAgent(aid, { run_id: runId });
    } else store.createAgent({ id: aid, runId, sessionId: p.session_id, type: str(p.agent_type), transcriptPath: subagentPath(aid, p.transcript_path, p.agent_transcript_path) });
    // The stages an agent reports on (token attribution).
    const stage = str(p.tool_input?.stage);
    const resp = JSON.stringify(p.tool_response ?? '');
    const failed = p.tool_response?.isError === true || resp.includes('ERROR:');
    if (tool === `${MCP_PREFIX}complete_stage` && stage && !failed) store.reportNode(aid, stage.slice(0, 80));
  }

  function handle(p) {
    const ev = p.hook_event_name;
    // Only the main session relays Ryan's answers, whatever the run state and even when unlinked.
    if (ev === 'PreToolUse' && p.tool_name === `${MCP_PREFIX}respond` && str(p.agent_id)) return deny("Agent Monitor: only the main session relays Ryan's answers.");
    if (ev === 'PreToolUse' && selfApi && str(p.agent_id) && (p.tool_name === 'Bash' || p.tool_name === 'PowerShell') && selfApi.test(String(p.tool_input?.command ?? ''))) {
      return deny('Agent Monitor: subagents may not call the Agent Monitor API directly; use the mcp__agent-monitor__ tools.');
    }
    if (typeof p.tool_name === 'string' && p.tool_name.startsWith(MCP_PREFIX) && ev === 'PostToolUse') link(p);
    const who = resolve(p);
    if (!who) return {};
    const { run, agentId } = who;
    const act = (event, tool, summary) => store.addActivity(run.id, agentId, event, tool, summary);
    const agent = () => store.getAgent(agentId);

    switch (ev) {
      case 'PreToolUse': {
        if (str(p.agent_id) && run.status === 'stopped' && !String(p.tool_name).startsWith(MCP_PREFIX)) {
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
      case 'Notification':
        act('notification', null, text(p.message ?? p.title, 120));
        break;
      default:
    }
    return {};
  }

  return { handle: (p) => { try { return p && typeof p === 'object' ? handle(p) : {}; } catch { return {}; } }, readTokens };
}
