// Claude account rotation for a tracked run: after a usage limit the run continues in a headless `claude --resume` on the
// next account (a fork of the stopped session), and resumes on the same session when Ryan answers a gate.
// Mirrors codex.js: never spawns a shell, never retries on its own. A new limit hit goes back to the server's coordinator.
import fs from 'node:fs';
import cp from 'node:child_process';
import { SAFE_EXE_ENV, MODES, defaultKillTree } from './exe.js';
import { safePath } from './transcripts.js';

const MAX_NOTE = 500;
const MAX_TRANSCRIPT_READ = 256 * 1024;
const SESSION_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i; // Claude session ids; anything else never reaches argv
const DROP_ENV = new Set(['claude_code_oauth_token', 'anthropic_api_key', 'anthropic_auth_token']); // the child uses the login file, never a token from the env

// The first string `cwd` field of a session transcript (first 256 KB only; a .jsonl inside projectsDir only), else null.
function transcriptCwd(file, projectsDir) {
  file = safePath(file, projectsDir);
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(MAX_TRANSCRIPT_READ);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    for (const line of buf.toString('utf8', 0, n).split('\n')) {
      let o;
      try { o = JSON.parse(line); } catch { continue; } // blank, or the cut-off last line
      if (typeof o?.cwd === 'string' && o.cwd) return o.cwd;
    }
  } catch { /* unreadable: fall back to the run's folders */ } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* closed */ }
  }
  return null;
}

const hasTranscript = (file, root) => { const f = safePath(file, root); try { return Boolean(f) && fs.statSync(f).isFile(); } catch { return false; } };

export function createClaudeResume({
  store, projectsDir, manager = null, onRunLimit = () => {}, command, args = [], spawn = cp.spawn, killTree = defaultKillTree,
  env = process.env, onChange = () => {},
} = {}) {
  const childEnv = { ...Object.fromEntries(Object.entries(env).filter(([k]) => !DROP_ENV.has(k.toLowerCase()))), ...SAFE_EXE_ENV };
  const children = new Map(); // runId -> {child, stopped, escalated, lastError, limitHit}; child is null while the cwd is being checked
  const pending = new Set(); // runIds with an answer waiting for the running child to end
  let closed = false;

  const live = (runId) => { const r = store.getRun(runId); return r && r.provider !== 'codex' && !['done', 'stopped'].includes(r.status) ? r : null; };
  const accountOf = (runId) => store.runAccount(runId)?.account ?? 'unknown';

  function escalate(runId, note) {
    if (closed || !live(runId)) return;
    store.escalate(runId, String(note).replace(/\s+/g, ' ').slice(0, MAX_NOTE));
    onChange();
  }

  function answerLine(run) {
    let a;
    try { a = JSON.parse(run.answer_json ?? 'null'); } catch { a = null; }
    if (!a) return '';
    return `Ryan answered at ${a.stage ?? run.stage}: ${a.action}${a.text ? ` - ${a.text}` : ''}. Call get_run with run "${run.id}" and continue from the current node.`;
  }

  function freshPrompt(run) {
    const ra = store.runAccount(run.id);
    return [
      `Agent Monitor run "${run.id}": ${run.title}`,
      `Claude account ${ra?.hit_account ?? 'unknown'} hit its usage limit; account ${ra?.account ?? 'unknown'} took over, so you continue this run headless.`,
      '',
      `Call the agent-monitor MCP tool get_run with run "${run.id}" first, continue from the current node, report each stage with complete_stage, and never push. When the run waits on Ryan, end your turn; Agent Monitor resumes you when he answers.`,
    ].join('\n');
  }

  // Which session to resume: the headless session when there is one, else the run's latest main session.
  function pickSession(runId, answer) {
    const ra = store.runAccount(runId);
    if (ra?.session_id) return { sid: ra.session_id, fork: !answer, file: store.getAgent(`main:${ra.session_id}`)?.transcript_path ?? store.latestMainSession(runId)?.transcript_path }; // same run, same folder
    const main = store.latestMainSession(runId);
    return main ? { sid: main.session_id, fork: true, file: main.transcript_path } : null;
  }

  async function pickCwd(file) {
    const c = transcriptCwd(file, projectsDir); // only the session's own transcript: hook payloads (cwds_json) are unauthenticated
    if (!c) throw new Error('no working folder known for this session');
    if (!(await fs.promises.stat(c).catch(() => null))?.isDirectory()) throw new Error(`working folder ${c} is not a directory`);
    return c;
  }

  // Starts the child. `answer`: Ryan answered, so resume the headless session as it is (with none yet: fork, with the answer added).
  async function launch(runId, { answer = false } = {}) {
    if (closed || !live(runId)) return;
    const entry = { child: null, stopped: false, escalated: false, lastError: null, limitHit: false, mode: 'default' };
    children.set(runId, entry);
    const drop = () => { if (children.get(runId) === entry) children.delete(runId); }; // never delete a newer launch's entry
    try {
      const run = live(runId);
      if (!run) return drop();
      if (!command) { drop(); return escalate(runId, 'Claude resume failed: claude not found'); }
      const picked = pickSession(runId, answer);
      if (!picked) { drop(); return escalate(runId, 'Claude resume failed: no Claude session known for this run'); }
      if (!UUID.test(picked.sid)) { drop(); return escalate(runId, 'Claude resume failed: the session id is not a Claude session id'); }
      let cwd;
      try { cwd = await pickCwd(picked.file); } catch (e) { drop(); return escalate(runId, `Claude resume failed: ${e.message}`); }
      if (entry.stopped) return drop();
      const saved = store.sessionMode(picked.sid);
      const mode = MODES.has(saved) && hasTranscript(picked.file, projectsDir) ? saved : 'default'; // a mode only counts for a session we saw
      entry.mode = mode;
      const argv = [...args, '--resume', picked.sid, ...(picked.fork ? ['--fork-session'] : []), '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', mode];
      const prompt = picked.fork ? [freshPrompt(run), answer ? answerLine(run) : ''].filter(Boolean).join('\n\n') : answerLine(run);
      attach(runId, entry, spawn(command, argv, { cwd, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }), prompt);
    } catch (e) {
      drop();
      escalate(runId, `Claude resume failed: ${e.message}`);
    }
  }

  function attach(runId, entry, child, prompt) {
    entry.child = child;
    let done = false;
    const finish = (fn) => {
      if (done || closed) return;
      done = true;
      if (children.get(runId) === entry) children.delete(runId);
      const answered = pending.delete(runId); // an answer waiting means a clean exit is expected, not a stall
      if (!entry.stopped) fn(answered);
      if (answered && !entry.stopped && live(runId)?.status === 'active') resume(runId).catch(() => {});
    };

    child.on('error', (e) => finish(() => { entry.escalated = true; escalate(runId, `Claude resume failed: ${e.message}`); }));
    child.on('close', (code) => finish((answered) => {
      const run = live(runId);
      if (entry.escalated || entry.limitHit || run?.status !== 'active') return;
      if (code !== 0) escalate(runId, `Claude (account ${accountOf(runId)}) exited with code ${code}${entry.lastError ? `: ${entry.lastError}` : ''}`);
      else if (!answered) escalate(runId, `Claude ended its turn but the run is still at ${store.summary(run).active.map((a) => a.id).join(', ') || 'no active node'}`);
    }));
    child.stdin?.on('error', () => {});
    child.stdin?.end(prompt);
    child.stderr?.resume();

    let buf = '';
    const onLine = (line) => {
      if (closed || entry.stopped) return;
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (!ev || typeof ev !== 'object') return;
      if (ev.type === 'system' && ev.subtype === 'init' && typeof ev.session_id === 'string' && SESSION_ID.test(ev.session_id)) {
        if (store.runAccount(runId)?.session_id !== ev.session_id) { store.setClaudeSession(runId, ev.session_id); store.noteMode(ev.session_id, entry.mode); onChange(); }
      } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info && typeof ev.rate_limit_info === 'object') {
        const info = ev.rate_limit_info;
        const account = store.runAccount(runId)?.account;
        if (account) { try { manager?.recordRateLimit?.(account, info); } catch { /* best effort */ } }
        if (info.status === 'rejected') {
          entry.limitHit = true;
          Promise.resolve(onRunLimit(runId, { at: new Date().toISOString(), resetsAt: info.resetsAt ?? null, source: 'headless' })).catch(() => {});
        }
      } else if (ev.type === 'result' && ev.is_error) {
        entry.lastError = String(ev.result ?? ev.subtype ?? 'error').slice(0, MAX_NOTE);
      }
    };
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
      if (buf.length > 1_000_000) buf = ''; // a runaway line without a newline
    });
    child.stdout?.on('end', () => { if (buf.trim()) onLine(buf); buf = ''; });
  }

  // The run moved to another account: a fresh fork of the stopped session continues it.
  const start = (runId) => launch(runId);

  // Ryan answered a gate: continue the same session, or wait for the running child to end.
  async function resume(runId) {
    if (closed || !live(runId)) return;
    if (children.has(runId)) { pending.add(runId); return; }
    await launch(runId, { answer: true });
  }

  function stop(runId) {
    pending.delete(runId);
    const entry = children.get(runId);
    if (!entry) return;
    entry.stopped = true;
    if (entry.child?.pid) killTree(entry.child.pid);
    children.delete(runId);
  }

  const running = (runId) => children.has(runId);
  function close() { closed = true; pending.clear(); for (const id of [...children.keys()]) stop(id); }

  return { start, resume, stop, running, close };
}
