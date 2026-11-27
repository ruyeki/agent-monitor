// Wakes a plain Claude chat that stopped at a usage limit: a tiny headless `claude -p` helper sends it a notice with the
// SendMessage tool (addressed by the chat's registry name), and the chat's registry entry confirms it was delivered.
// Never throws or rejects: every failure resolves {ok:false, reason}, and the server falls back to a notification.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { SAFE_EXE_ENV, MODES, defaultKillTree } from './exe.js';
import { guardReal } from './accounts/paths.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACCOUNT = /^[a-z0-9-]{1,64}$/;
const REGISTRY_FILE = /^\d+\.json$/; // never open anything else in the folder: the <pid>.<id>.key files are secrets
const HELPER_NAME = 'agent-monitor';
const MAX_HELPER_IDS = 50;
const MAX_DONE = 200;
const DROP_ENV = new Set(['claudecode', 'anthropic_api_key', 'anthropic_auth_token', 'claude_pid', 'claude_effort', 'claude_agent_sdk_version']);
const SYSTEM_PROMPT = 'You deliver one status notice with the SendMessage tool, then stop.';

const noticeFor = (account) => `Agent Monitor (automatic notice): your last turn stopped at a Claude usage limit. The login was switched to account ${account}, which has usage left, so the limit no longer applies. This is a status notice, not a request; no reply is needed.`;
const promptFor = (name, notice) => `Call the SendMessage tool exactly once with this input, copied exactly:\n${JSON.stringify({ to: name, message: notice })}\nDo not call any other tool. After it returns, reply with only the tool result text.`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The helper must share the chat's config dir but never carry the parent's identity or an API key.
function cleanEnv(env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    const key = k.toLowerCase();
    if (DROP_ENV.has(key) || (key.startsWith('claude_code_') && key !== 'claude_code_git_bash_path')) continue;
    out[k] = v;
  }
  return { ...out, ...SAFE_EXE_ENV };
}

function defaultIsAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } // ESRCH = gone
}

// A plain whitelist: no quote, brace, backslash or line separator can reach the helper's prompt.
const NAME_OK = /^[\p{L}\p{N} ._'(),:&+#\/!?-]{1,100}$/u;
const validName = (n) => typeof n === 'string' && NAME_OK.test(n) && n !== HELPER_NAME;

export function createChatWake({
  sessionsDir, command, args = [], spawn = cp.spawn, killTree = defaultKillTree, env = process.env, modeOf = () => null,
  isAlive = defaultIsAlive, clock = Date.now, idleWaitMs = 30_000, confirmWaitMs = 5_000, pollMs = 500, helperTimeoutMs = 90_000,
  dedupeMs = 10 * 60_000, maxConcurrent = 2, maxQueue = 8, cwd = null,
} = {}) {
  const off = !sessionsDir || !command;
  if (sessionsDir) guardReal(sessionsDir, process.env);
  const childEnv = cleanEnv(env);
  const inflight = new Map(); // sessionId -> promise
  const done = new Map(); // `${sessionId}|${account}` -> {at, name, found, repeats} of the last finished wake (one per limit)
  const helperIds = new Set();
  const running = new Set(); // {child}
  const queue = []; // resolvers waiting for a helper slot
  let active = 0; // slots taken (a slot is taken before the helper spawns)
  let closed = false;
  let privateCwd = null; // fallback helper folder: created once, empty, ours (never the shared temp folder itself)

  const fail = (reason, extra = {}) => ({ ok: false, reason, name: undefined, found: false, quiet: false, ...extra });

  // Live registry entries (stale pids dropped). Only `<pid>.json` files are opened; bad JSON is skipped.
  function registry() {
    let files;
    try { files = fs.readdirSync(sessionsDir); } catch { return []; }
    const out = [];
    for (const f of files) {
      if (!REGISTRY_FILE.test(f)) continue;
      let o;
      try { o = JSON.parse(fs.readFileSync(path.join(sessionsDir, f), 'utf8')); } catch { continue; }
      if (!o || typeof o !== 'object' || !Number.isInteger(o.pid) || typeof o.sessionId !== 'string') continue;
      let alive = false;
      try { alive = isAlive(o.pid); } catch { /* treat as gone */ }
      if (alive) out.push(o);
    }
    return out;
  }
  const entryOf = (sessionId) => registry().find((e) => e.sessionId === sessionId) ?? null;

  const noteHelper = (id) => {
    helperIds.add(id);
    if (helperIds.size > MAX_HELPER_IDS) helperIds.delete(helperIds.values().next().value);
  };
  const isHelper = (sessionId) => helperIds.has(sessionId);

  // Takes a helper slot (waiting in the queue if all are taken); a reason string when it cannot.
  async function slot() {
    if (active >= maxConcurrent) {
      if (queue.length >= maxQueue) return 'busy';
      if (!(await new Promise((resolve) => queue.push(resolve)))) return 'closed'; // the releaser hands its slot over
    } else active++;
    return null;
  }
  const release = () => { if (queue.length) queue.shift()(true); else active--; };

  // One helper run: resolves {reason} on failure, {} when SendMessage reported success.
  function runHelper(name, mode, notice) {
    return new Promise((resolve) => {
      const argv = [...args, '-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode, '--tools', 'SendMessage', '--strict-mcp-config',
        '--max-turns', '3', '--name', HELPER_NAME, '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--system-prompt', SYSTEM_PROMPT];
      const handle = { child: null, finish: null };
      let settled = false;
      let timer = null;
      let sent = null; // SendMessage's own success flag
      let held = false;
      const toolUses = []; // every tool call the helper made: only the one asked-for SendMessage is acceptable
      const finish = (r) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        running.delete(handle);
        resolve(r);
      };
      handle.finish = finish;
      let child;
      try {
        let dir = cwd;
        if (dir) fs.mkdirSync(dir, { recursive: true });
        else dir = privateCwd ??= fs.mkdtempSync(path.join(os.tmpdir(), 'am-chat-wake-'));
        child = spawn(command, argv, { cwd: dir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv });
      } catch { return finish({ reason: 'spawn error' }); }
      handle.child = child;
      running.add(handle);
      timer = setTimeout(() => { if (!settled) { if (child.pid) killTree(child.pid); finish({ reason: 'timeout' }); } }, helperTimeoutMs);
      child.on('error', () => finish({ reason: 'spawn error' }));
      child.on('close', () => {
        if (closed) return finish({ reason: 'closed' });
        if (held) return finish({ reason: 'held' });
        if (sent === true) {
          const u = toolUses[0];
          const same = toolUses.length === 1 && u.name === 'SendMessage' && u.input?.to === name && String(u.input?.message).trim() === notice.trim();
          return finish(same ? {} : { reason: 'send mismatch' });
        }
        finish({ reason: sent === false ? 'send failed' : 'not delivered' });
      });
      child.stdin?.on('error', () => {});
      child.stdin?.end(promptFor(name, notice));
      child.stderr?.resume();

      const onLine = (line) => {
        let ev;
        try { ev = JSON.parse(line); } catch { return; }
        if (!ev || typeof ev !== 'object') return;
        if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && UUID.test(ev.session_id)) noteHelper(ev.session_id);
        else if (ev.type === 'system' && ev.subtype === 'informational' && /held/i.test(String(ev.content ?? ''))) held = true;
        else if (ev.type === 'assistant' && Array.isArray(ev.message?.content)) {
          for (const c of ev.message.content) if (c?.type === 'tool_use') toolUses.push({ name: c.name, input: c.input });
        } else if (ev.type === 'user' && Array.isArray(ev.message?.content)) {
          for (const c of ev.message.content) {
            if (c?.type !== 'tool_result') continue;
            const text = typeof c.content === 'string' ? c.content : Array.isArray(c.content) ? c.content.map((p) => p?.text ?? '').join('') : '';
            let r;
            try { r = JSON.parse(text); } catch { continue; }
            if (r && typeof r.success === 'boolean') sent = r.success;
          }
        }
      };
      let buf = '';
      child.stdout?.setEncoding?.('utf8');
      child.stdout?.on('data', (chunk) => {
        buf += chunk;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        if (buf.length > 1_000_000) buf = ''; // a runaway line without a newline
      });
      child.stdout?.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
    });
  }

  async function attempt(sessionId, account) {
    const entry = entryOf(sessionId);
    if (!entry) return fail('not found');
    if (!validName(entry.name)) return fail('bad name', { found: true });
    const name = entry.name;
    const base = { name, found: true };
    if (registry().filter((e) => e.name === name).length !== 1) return fail('ambiguous name', base);
    const known = modeOf(sessionId);
    if (!known || !MODES.has(known)) return fail('mode unknown', base);
    const mode = known === 'bypassPermissions' ? 'bypassPermissions' : 'manual'; // the CLI has no "default" choice

    let idle = false;
    for (let i = 0, n = Math.ceil(idleWaitMs / pollMs); i <= n && !closed; i++) {
      const cur = entryOf(sessionId);
      if (!cur) return fail('not found', { found: true, name });
      if (cur.status === 'idle') { idle = true; break; }
      if (i < n) await sleep(pollMs);
    }
    if (!idle) return fail(closed ? 'closed' : 'not idle', base);

    const busy = await slot();
    if (busy) return fail(busy, base);
    if (closed) { release(); return fail('closed', base); }
    const spawnedAt = clock();
    let r;
    try { r = await runHelper(name, mode, noticeFor(account)); } finally { release(); }
    if (r.reason) return fail(r.reason, base);

    for (let i = 0, n = Math.ceil(confirmWaitMs / pollMs); i <= n && !closed; i++) {
      const cur = entryOf(sessionId);
      if (cur && Number(cur.statusUpdatedAt) > spawnedAt) return { ok: true, name, reason: undefined, found: true, quiet: false };
      if (i < n) await sleep(pollMs);
    }
    return fail('not delivered', base);
  }

  function wake(sessionId, { account } = {}) {
    try {
      if (off || closed) return Promise.resolve(fail('off'));
      if (typeof sessionId !== 'string' || !UUID.test(sessionId)) return Promise.resolve(fail('bad session id'));
      if (isHelper(sessionId)) return Promise.resolve(fail('helper session'));
      if (typeof account !== 'string' || !ACCOUNT.test(account)) return Promise.resolve(fail('bad account'));
      if (inflight.has(sessionId)) return inflight.get(sessionId).then((r) => ({ ...r, quiet: true })); // a joiner must not notify again
      const key = `${sessionId}|${account}`;
      const last = done.get(key);
      if (last && clock() - last.at < dedupeMs) {
        const quiet = last.repeats++ > 0; // the first repeat may still tell Ryan; the rest of the window is silent
        return Promise.resolve(fail('woken recently', { name: last.name, found: last.found, quiet }));
      }
      const p = attempt(sessionId, account).catch(() => fail('error')).then((r) => {
        inflight.delete(sessionId);
        if (r.found) { // forged ids must not push a real chat's record out
          done.set(key, { at: clock(), name: r.name, found: true, repeats: 0 });
          if (done.size > MAX_DONE) done.delete(done.keys().next().value);
        }
        return r;
      });
      inflight.set(sessionId, p);
      return p;
    } catch { return Promise.resolve(fail('error')); }
  }

  function close() {
    closed = true;
    for (const h of [...running]) {
      if (h.child?.pid) { try { killTree(h.child.pid); } catch { /* already gone */ } }
      h.finish({ reason: 'closed' });
    }
    while (queue.length) queue.shift()(false); // a waiter handed a slot by release() has not run yet; it checks `closed`
  }

  return { wake, isHelper, close };
}
