// Claude hook events -> per-agent tracking. Never throws: every problem answers {}.
import path from 'node:path';
import { MODES } from './exe.js';
import { isChangeCandidate, isHephaestusUpdate, hephInfo, ledgerText, ledgerResult, redact, SHELL_TOOLS } from './ledger.js';
import { planFill, readCommits, postOnlyStart } from './commitfill.js';
import { fileSize, readUsage, readMeta, subagentPath } from './transcripts.js';

// Tools a Claude session may still use on a run that was handed over to Codex.
const READ_TOOLS = new Set(['get_run', 'list_runs', 'get_workflow', 'log', 'respond']);
const ENDED = ['done', 'stopped'];
const LIVE = ['active', 'waiting'];
const TOKEN_READ_EVERY_MS = 5000;
const MAX_PENDING = 2000;
const MAX_CHANGE_INPUT = 2000;
const MAX_CHANGE_RESULT = 1000;
const MAX_OPEN_CHANGES = 2000;
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

const text = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const str = (v) => (typeof v === 'string' && v ? v : null);

// The one-line summary of a call: masked like the Ledger copy, then cut to 120 chars (masking first, so a cut cannot split a secret).
function rawSummary(input) {
  if (!input || typeof input !== 'object') return '';
  const first = Object.values(input).find((v) => typeof v === 'string');
  return text(input.command ?? input.file_path ?? input.pattern ?? input.description ?? input.url ?? first, 600);
}
function summarize(input) {
  return redact(rawSummary(input)).slice(0, 120);
}

const jsonOf = (v) => { try { return typeof v === 'string' ? v : JSON.stringify(v ?? ''); } catch { return ''; } };
// A Hephaestus status change is stored as a compact {task_id, status}: the full JSON may carry a long description first
// and be cut before the status.
function changeInput(tool, input) {
  if (isHephaestusUpdate(tool)) {
    const { id, status } = hephInfo(jsonOf(input));
    if (status) return JSON.stringify({ task_id: id, status });
  }
  return SHELL_TOOLS.test(tool) && typeof input?.command === 'string' ? input.command : jsonOf(input);
}
function changeResult(tool, resp, error) {
  if (error != null) return String(error);
  if (SHELL_TOOLS.test(tool) && resp && typeof resp === 'object') {
    // GitHub's remote: banner lines would push the push and PR lines out of the 1000-char cap, so they are dropped here.
    const out = `${resp.stdout ?? ''}${resp.stderr ? `
${resp.stderr}` : ''}`;
    return out.split('\n').filter((line) => !line.startsWith('remote:')).join('\n');
  }
  return jsonOf(resp);
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

export function createHooks(store, { projectsDir, port, defer = setImmediate, clock = Date.now, onLimit, onChatLimit } = {}) {
  // A command aimed at our own port on a loopback host: subagents must use the MCP tools instead.
  const selfApi = port ? new RegExp(`(?:127\\.\\d+\\.\\d+\\.\\d+|localhost|\\[::1\\]|0\\.0\\.0\\.0):${port}(?!\\d)`, 'i') : null;
  const openChanges = new Set(); // tool_use_ids that got a ledger row: only those get a result built and masked
  const pending = new Map(); // tool_use_id -> {sid, agentId, tool, key}
  const lastRead = new Map(); // agent id -> ms of the last transcript read
  const orphans = new Map(); // meta toolUseId -> child agent id whose parent is not known yet (the spawning call's Post names it)
  const guessed = new Set(); // subagents whose parent came from the pending-call fallback (meta.json may still correct it)
  const modes = new Map(); // session id -> last permission mode written (skips repeat writes)
  const headlessDeny = (runId, sessionId) => {
    const ra = store.headlessRun(runId);
    return ra && ra.session_id !== sessionId ? deny(`Agent Monitor: run ${runId} continues headless on Claude account ${ra.account ?? 'unknown'}. Stop work and report back.`) : null;
  };

  // The parent from the subagent's meta.json toolUseId (the most reliable source), else null. Never the agent itself.
  function parentFromMeta(a, meta) {
    const known = (id) => (id && id !== a.agent_id && store.getAgent(id) ? id : null);
    const useId = str(meta?.toolUseId);
    // The spawning call's row, else a depth-2+ meta's parentAgentId, else a depth-1 child's main session.
    const parent = known(store.agentOfToolUse(a.run_id, useId)) ?? known(str(meta?.parentAgentId))
      ?? (meta?.spawnDepth === 1 ? known(`main:${a.session_id}`) : null);
    if (!parent && useId && !orphans.has(useId)) {
      if (orphans.size >= MAX_PENDING) orphans.delete(orphans.keys().next().value);
      orphans.set(useId, a.agent_id);
    }
    return parent;
  }
  function setParent(a, parent, viaFallback) {
    if (!parent || parent === a.agent_id) return;
    if (parent !== a.parent_agent_id) store.updateAgent(a.agent_id, { parent_agent_id: parent });
    if (!viaFallback) guessed.delete(a.agent_id);
    else {
      if (guessed.size >= MAX_PENDING) guessed.delete(guessed.values().next().value);
      guessed.add(a.agent_id);
    }
  }
  // Fallback: the Agent/Task calls still open in the same session; one agent behind all of them -> that agent.
  function parentFromPending(a) {
    const owners = new Set();
    for (const c of pending.values()) if (c.sid === a.session_id && SPAWN_TOOLS.has(c.tool) && c.agentId !== a.agent_id) owners.add(c.agentId);
    return owners.size === 1 ? [...owners][0] : null;
  }

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
    // meta.json is read while the description or the parent is still missing (or only guessed).
    const wantParent = !a.parent_agent_id || guessed.has(agentId);
    if (a.type !== 'main' && (!a.description || wantParent)) {
      const meta = readMeta(file, projectsDir);
      if (meta && !a.description) Object.assign(fields, { description: str(meta.description), model: fields.model ?? a.model ?? str(meta.model) });
      if (meta && wantParent) setParent(a, parentFromMeta(a, meta), false);
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

  // The run an event belongs to right now, without creating anything.
  function runOf(p, provider) {
    const aid = str(p.agent_id);
    const bound = (aid && store.getAgent(aid)) || (provider === 'codex' && !aid && store.getAgent(`codex:${p.session_id}`));
    if (bound) return bound.run_id;
    return store.sessionRun(p.session_id, { adoptStopped: provider === 'codex' || Boolean(aid) })?.id ?? null;
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
        // Another session may not report on a run a headless session continues after an account switch.
        if ((tool === 'complete_stage' || tool === 'log') && target) { const d = headlessDeny(target, p.session_id); if (d) return d; }
      }
    }
    if (!codex && !str(p.agent_id) && typeof p.session_id === 'string' && MODES.has(p.permission_mode) && modes.get(p.session_id) !== p.permission_mode) {
      if (modes.size >= MAX_PENDING) modes.delete(modes.keys().next().value);
      modes.set(p.session_id, p.permission_mode);
      store.noteMode(p.session_id, p.permission_mode); // a headless fork keeps the mode the stopped session had
    }
    if (!codex && ev === 'UserPromptSubmit' && !str(p.agent_id) && typeof p.session_id === 'string') store.releaseSession(p.session_id);
    // An agent-monitor tool whose link() moves this event onto a run it was not on before (start_run) is the linking call: not counted.
    // (Mirrors resolve(): the run this call was on before link() may move it. Only Post events count a call.)
    const before = tool && (ev === 'PostToolUse' || ev === 'PostToolUseFailure') ? runOf(p, provider) : null;
    if (tool && ev === 'PostToolUse') link(p, provider);
    const who = resolve(p, provider);
    if (!who) {
      // A rate limit in a plain chat (no live run): the account switcher may move the login. Never blocks.
      if (!codex && ev === 'StopFailure' && p.error === 'rate_limit' && !str(p.agent_id) && typeof p.session_id === 'string' && onChatLimit) {
        const info = { sessionId: p.session_id, at: new Date(clock()).toISOString(), resetsAt: isoTime(p.error_details?.resetsAt ?? p.error_details?.resets_at), source: 'stopfailure' };
        defer(() => { try { Promise.resolve(onChatLimit(info)).catch(() => {}); } catch { /* best effort */ } });
      }
      return {};
    }
    const { run, agentId } = who;
    if (!codex && typeof p.cwd === 'string' && (run.provider ?? 'claude') === 'claude') store.noteCwd(run.id, p.cwd);
    const act = (event, tool, summary, toolUseId) => store.addActivity(run.id, agentId, event, tool, summary, toolUseId);
    const agent = () => store.getAgent(agentId);
    // One tool call: agent counters, the 'tool' activity row and (for a change candidate) the Ledger row. True when a Ledger row was added.
    const recordCall = () => {
      const summary = summarize(p.tool_input);
      store.updateAgent(agentId, { last_tool: text(p.tool_name, 80), last_summary: summary, tool_calls: agent().tool_calls + 1, last_activity_at: new Date().toISOString(), waiting_permission: 0 });
      act('tool', text(p.tool_name, 80), summary, p.tool_use_id);
      if (!isChangeCandidate(p.tool_name, p.tool_input)) return false;
      store.addChange(run.id, agentId, text(p.tool_name, 80), p.tool_use_id, ledgerText(changeInput(p.tool_name, p.tool_input), MAX_CHANGE_INPUT));
      return true;
    };

    // A commit whose `[branch hash]` line the output hid: read it back from git later (deferred, one call, best effort).
    const fillCommits = (runId, useId, p, startedAt, failed) => {
      try {
        if (!useId || !SHELL_TOOLS.test(p.tool_name || '')) return;
        const plan = planFill(p.tool_input?.command, p.cwd, changeResult(p.tool_name, p.tool_response, failed ? p.error : null));
        if (!plan) return;
        defer(() => readCommits(plan, startedAt).then((block) => { if (block) store.appendChangeResult(runId, useId, redact(block)); }).catch(() => {}));
      } catch { /* the fill is best effort */ }
    };

    switch (ev) {
      case 'PreToolUse': {
        if (!codex && run.provider === 'codex' && !ENDED.includes(run.status) && !READ_TOOLS.has(tool)) {
          return deny(`Agent Monitor: run handed over to Codex (run ${run.id}). Stop work and report back.`);
        }
        if (!codex && !READ_TOOLS.has(tool)) { const d = headlessDeny(run.id, p.session_id); if (d) return d; }
        if ((codex || str(p.agent_id)) && run.status === 'stopped' && !tool) {
          return deny(`Agent Monitor: run ${run.id} was stopped by Ryan. Stop work and report back.`);
        }
        if (recordCall() && str(p.tool_use_id)) {
          if (openChanges.size >= MAX_OPEN_CHANGES) openChanges.delete(openChanges.values().next().value);
          openChanges.add(p.tool_use_id);
        }
        if (p.tool_use_id) {
          if (pending.size >= MAX_PENDING) pending.delete(pending.keys().next().value);
          pending.set(p.tool_use_id, { sid: p.session_id, agentId, tool: p.tool_name, key: stable(p.tool_input), at: clock() });
        }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': {
        const useId = str(p.tool_use_id);
        // Without PreToolUse this is the only event of the call: record it now (not the call that just linked this run).
        const fresh = Boolean(useId) && !pending.has(useId) && !store.hasToolCall(run.id, useId) && (!tool || before === run.id);
        const startedAt = pending.get(p.tool_use_id)?.at ?? postOnlyStart(clock());
        pending.delete(p.tool_use_id);
        const candidate = fresh && recordCall();
        const fields = { waiting_permission: 0, last_activity_at: new Date().toISOString() };
        if (ev === 'PostToolUseFailure') {
          Object.assign(fields, { errors: agent().errors + 1, last_error: text(p.error, 200) });
          act('error', text(p.tool_name, 80), text(p.error, 120), p.tool_use_id);
        }
        store.endActivity(run.id, p.tool_use_id, ev === 'PostToolUse' ? 'ok' : 'error');
        if (openChanges.delete(p.tool_use_id) || candidate) {
          store.endChange(run.id, p.tool_use_id, ev === 'PostToolUse' ? 'ok' : 'error',
            ledgerResult(changeResult(p.tool_name, p.tool_response, ev === 'PostToolUse' ? null : p.error), MAX_CHANGE_RESULT));
          fillCommits(run.id, useId, p, startedAt, ev !== 'PostToolUse');
        }
        store.updateAgent(agentId, fields);
        // The spawning call's Post names the parent of a child whose meta.json only had a toolUseId.
        const child = SPAWN_TOOLS.has(p.tool_name) && useId ? orphans.get(useId) : null;
        if (child) {
          orphans.delete(useId);
          const c = store.getAgent(child);
          if (c) setParent(c, agentId, false);
        }
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
      case 'SubagentStart': {
        act('subagent_start', null, text(p.agent_type, 80));
        const a = agent();
        if (a && !codex && a.type !== 'main') {
          const fromMeta = parentFromMeta(a, readMeta(a.transcript_path, projectsDir));
          if (fromMeta) setParent(a, fromMeta, false);
          else if (!a.parent_agent_id) setParent(a, parentFromPending(a), true);
        }
        break;
      }
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
