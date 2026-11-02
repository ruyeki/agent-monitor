// Claude -> Codex hand-off: starts `codex exec` for a run that ran out of Claude usage, resumes it when Ryan answers a gate,
// and sends the run to its Decision node when Codex fails or hits its own limit. Never spawns a shell, never retries.
import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { CODEX_ROOT, HANDOFF, HANDOFF_PROFILE, DISABLED_FEATURES, checkCodexConfig } from './codex-config.js';

const MAX_NOTE = 500;
const MAX_STATUS_LINES = 40;
const THREAD_ID = /^[0-9A-Za-z][0-9A-Za-z_-]{0,127}$/;
// Segments exclude separators and ':', so match attempts cannot overlap (linear); only the note's tail is scanned.
const SPEC_PATH = /[A-Za-z]:(?:[\\/][^\\/\r\n"'<>|*?:]+)*?[\\/]fable-runs[\\/][^\\/\r\n"'<>|*?:]+[\\/](spec|facts)\.md/g;
const SCAN_TAIL = 8192;
const LIMIT_TEXT = /hit your usage limit/i;
const lower = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

// An absolute path to an executable, found on PATH only: never the current directory (Windows would pick <cwd>\name.exe first).
function resolveExe(name, env) {
  if (path.isAbsolute(name)) return name;
  const win = process.platform === 'win32';
  const exts = win ? (/\.(exe|com)$/i.test(name) ? [''] : ['.exe', '.com']) : [''];
  const pathVar = win ? Object.keys(env).find((k) => k.toLowerCase() === 'path') : 'PATH';
  for (const dir of String(env[pathVar] ?? '').split(path.delimiter)) {
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* not here */ }
    }
  }
  return null;
}
const SAFE_EXE_ENV = { NoDefaultCurrentDirectoryInExePath: '1' };

const defaultKillTree = (pid) => {
  if (process.platform === 'win32') {
    const taskkill = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe');
    cp.execFile(taskkill, ['/pid', String(pid), '/T', '/F'], { windowsHide: true, env: { ...process.env, ...SAFE_EXE_ENV } }, () => {});
  } else { try { process.kill(pid); } catch { /* already gone */ } }
};

export function createCodex({
  store, usage, enabled = false, command = 'codex', args = [], root = CODEX_ROOT, spawn = cp.spawn, execFile = cp.execFile,
  killTree = defaultKillTree, env = process.env, onChange = () => {},
} = {}) {
  const commandPath = resolveExe(command, env); // once, here: a bare name is never handed to spawn
  const gitPath = resolveExe('git', env);
  const childEnv = { ...env, ...SAFE_EXE_ENV };
  const children = new Map(); // runId -> {child, stopped, escalated, lastError}; child is null while the cwd is being checked
  const pending = new Set(); // runIds with an answer waiting for the running child to end
  const dirs = new Map(); // runId -> the work tree the first launch used
  let closed = false; // once true nothing touches the store or usage again (the server closes them next)

  const git = (dir, gitArgs) => new Promise((resolve, reject) => {
    if (!gitPath) return reject(new Error('git not found on PATH'));
    // core.fsmonitor=false: a repo's own config must not run a command here.
    execFile(gitPath, ['-c', 'core.fsmonitor=false', '-C', dir, ...gitArgs], { windowsHide: true, timeout: 15000, env: childEnv }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
  const live = (runId) => { const r = store.getRun(runId); return r && r.provider === 'codex' && !['done', 'stopped'].includes(r.status) ? r : null; };

  function escalate(runId, note) {
    if (closed || !live(runId)) return;
    store.escalate(runId, String(note).replace(/\s+/g, ' ').slice(0, MAX_NOTE));
    onChange();
  }

  // The first candidate that is a git work tree inside the root (real paths, so a junction or '..' cannot escape).
  async function pickDir(run) {
    let rootReal;
    try { rootReal = await fs.promises.realpath(root); } catch { return null; }
    const candidates = [];
    if (run.repo) candidates.push(path.isAbsolute(run.repo) ? run.repo : path.join(root, run.repo));
    try { candidates.push(...JSON.parse(run.cwds_json ?? '[]')); } catch { /* none */ }
    for (const c of candidates) {
      try {
        if (typeof c !== 'string' || !(await fs.promises.stat(c)).isDirectory()) continue;
        const real = await fs.promises.realpath(c);
        const rel = path.relative(lower(rootReal), lower(real));
        if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) continue;
        if ((await git(real, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true') return real;
      } catch { /* try the next one */ }
    }
    return null;
  }

  async function handoffPrompt(run, dir) {
    const s = store.summary(run);
    const d = store.detail(run.id);
    const found = {};
    for (const text of [run.note, ...d.activity.map((a) => a.summary)]) {
      for (const m of String(text ?? '').slice(-SCAN_TAIL).matchAll(SPEC_PATH)) found[m[1]] ??= m[0];
    }
    let status = '';
    try { status = (await git(dir, ['status', '--short', '--branch'])).split('\n').slice(0, MAX_STATUS_LINES).join('\n').trim(); } catch { /* best effort */ }
    return [
      `Agent Monitor run "${run.id}": ${s.title}`,
      `Status: ${s.status}. Claude ran out of usage, so you continue this run.`,
      `Active nodes: ${s.active.map((a) => `${a.id} (${a.name})`).join(', ') || 'none'}`,
      found.spec ? `Spec: ${found.spec}` : null,
      found.facts ? `Fact sheet: ${found.facts}` : null,
      `Repo: ${dir}`,
      `git status:\n${status || '(clean or unavailable)'}`,
      '',
      `Call the agent-monitor MCP tool get_run with run "${run.id}" first, then continue from the current node and report each stage with complete_stage. Never push. When the run waits on Ryan, end your turn; Agent Monitor resumes you when he answers.`,
    ].filter((l) => l !== null).join('\n');
  }

  function answerLine(run) {
    let a;
    try { a = JSON.parse(run.answer_json ?? 'null'); } catch { a = null; }
    if (!a) return '';
    return `Ryan answered at ${a.stage ?? run.stage}: ${a.action}${a.text ? ` — ${a.text}` : ''}. Call get_run with run "${run.id}" and continue from the current node.`;
  }

  const modelArgs = [
    '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, ...DISABLED_FEATURES.flatMap((f) => ['--disable', f]),
  ];

  // Starts the child: fresh when the run has no thread yet, else `exec resume`. `answer` makes a resume prompt.
  async function launch(runId, { answer = false } = {}) {
    const entry = { child: null, stopped: false, escalated: false, lastError: null };
    children.set(runId, entry);
    try {
      const run = live(runId);
      if (!run) return children.delete(runId);
      if (!commandPath) { children.delete(runId); return escalate(runId, `Codex could not start: ${command} not found on PATH`); }
      const errors = checkCodexConfig();
      if (errors.length) { children.delete(runId); return escalate(runId, `Codex hand-off failed: ${errors[0]}`); }
      const dir = dirs.get(runId) ?? await pickDir(run);
      if (entry.stopped) return children.delete(runId);
      if (!dir) { children.delete(runId); return escalate(runId, `Codex hand-off failed: no git work tree under ${root} for this run.`); }
      dirs.set(runId, dir);
      const thread = run.codex_thread_id;
      const fresh = !thread;
      const argv = fresh
        ? [...args, 'exec', '--json', '-p', HANDOFF_PROFILE, ...modelArgs, '-C', dir, '-']
        : [...args, 'exec', '-p', HANDOFF_PROFILE, 'resume', '--json', ...modelArgs, thread, '-'];
      const prompt = fresh ? [await handoffPrompt(run, dir), answer ? answerLine(run) : ''].filter(Boolean).join('\n\n') : answerLine(run);
      if (entry.stopped) return children.delete(runId);
      attach(runId, entry, spawn(commandPath, argv, { cwd: dir, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: childEnv }), prompt);
    } catch (e) {
      children.delete(runId);
      escalate(runId, `Codex could not start: ${e.message}`);
    }
  }

  function attach(runId, entry, child, prompt) {
    entry.child = child;
    let done = false;
    const failed = (msg) => {
      if (entry.escalated) return;
      entry.escalated = true;
      escalate(runId, LIMIT_TEXT.test(msg) ? `Codex usage limit hit: ${msg}` : `Codex failed: ${msg}`);
    };
    const finish = (fn) => {
      if (done || closed) return;
      done = true;
      if (children.get(runId) === entry) children.delete(runId);
      const answered = pending.delete(runId); // decided first: an answer waiting means a clean exit is expected, not a stall
      if (!entry.stopped) fn(answered);
      if (answered && !entry.stopped && live(runId)?.status === 'active') resume(runId);
    };

    child.on('error', (e) => finish(() => { entry.escalated = true; escalate(runId, `Codex could not start: ${e.message}`); }));
    child.on('close', (code) => finish((answered) => {
      const run = live(runId);
      if (entry.escalated || run?.status !== 'active') return;
      if (code !== 0) escalate(runId, `Codex exited with code ${code}${entry.lastError ? `: ${entry.lastError}` : ''}`);
      else if (!answered) escalate(runId, `Codex ended its turn but the run is still at ${store.summary(run).active.map((a) => a.id).join(', ') || 'no active node'}`);
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
      if (ev.type === 'thread.started' && typeof ev.thread_id === 'string' && THREAD_ID.test(ev.thread_id)) {
        store.setCodexThread(runId, ev.thread_id);
        onChange();
      } else if (ev.type === 'turn.completed') {
        const thread = store.getRun(runId)?.codex_thread_id;
        if (thread && ev.usage) { usage?.addCodexTurn({ runId, threadId: thread, model: HANDOFF.model, usage: ev.usage }); onChange(); }
      } else if (ev.type === 'turn.failed') failed(String(ev.error?.message ?? 'turn failed'));
      else if (ev.type === 'error') {
        const msg = String(ev.message ?? 'error');
        if (LIMIT_TEXT.test(msg)) failed(msg); else entry.lastError = msg.slice(0, MAX_NOTE);
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

  // The first limit hit of a run. Only the first call acts (markLimit is atomic).
  async function trigger(runId, info = {}) {
    if (closed) return;
    if (!store.markLimit(runId, info)) return;
    onChange();
    if (!enabled) { store.logRun(runId, 'Codex hand-off is off'); return; }
    const status = store.getRun(runId)?.status;
    store.handOver(runId);
    onChange();
    if (status === 'active') await launch(runId); // a waiting run starts when Ryan answers
  }

  // Ryan answered a gate on a Codex run: continue the same thread, or wait for the running child to end.
  async function resume(runId) {
    if (closed || !enabled || !live(runId)) return;
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

  return { trigger, resume, stop, running, close };
}
