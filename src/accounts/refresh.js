// Runs Claude Code itself in a temp config dir (CLAUDE_CONFIG_DIR) to refresh a saved login or sign in a new one.
// Never calls Anthropic directly. The temp dir holds a login only while the child runs and is always removed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { validOauth } from './creds.js';

export const REFRESH_TIMEOUT_MS = 120_000;
export const LOGIN_TIMEOUT_MS = 600_000;
const DROP_ENV = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'];
const REFRESH_ARGS = ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--strict-mcp-config'];
const PROMPT = 'Reply with the single word OK.';

// claude: an absolute path, or {command, args} (tests pass process.execPath + a stub).
export function claudeCommand(claude) {
  const c = typeof claude === 'string' ? { command: claude, args: [] } : { command: claude?.command, args: claude?.args ?? [] };
  if (!c.command) throw new Error('Claude Code was not found');
  return c;
}

function childEnv(env, dir) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (!DROP_ENV.includes(k.toUpperCase()) && k.toUpperCase() !== 'CLAUDE_CONFIG_DIR') out[k] = v;
  return { ...out, CLAUDE_CONFIG_DIR: dir, NoDefaultCurrentDirectoryInExePath: '1' };
}

const why = (r) => (r.timedOut ? 'timed out' : r.error ? r.error.code ?? 'could not start' : `exit ${r.code}`);
const readLogin = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, '.credentials.json'), 'utf8'))?.claudeAiOauth ?? null; } catch { return null; }
};

// Runs fn(dir) in a fresh temp dir and removes it afterwards, whatever happens.
async function inTemp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-claude-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
}

// Spawns claude and resolves {code, timedOut} when it ends. onLine gets each stdout line when stdout is piped.
function runChild(spawn, { command, args }, argv, { dir, env, stdio, input, timeoutMs, onLine }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, [...args, ...argv], { cwd: dir, shell: false, windowsHide: true, stdio, env: childEnv(env, dir) });
    } catch (e) { return resolve({ code: null, error: e }); }
    let timedOut = false;
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ ...r, timedOut }); } };
    const timer = setTimeout(() => { timedOut = true; try { child.kill(); } catch { /* gone */ } }, timeoutMs);
    child.on('error', (error) => done({ code: null, error }));
    child.on('close', (code) => done({ code }));
    if (child.stdin && input != null) { child.stdin.on('error', () => {}); child.stdin.end(input); }
    child.stderr?.resume();
    if (child.stdout && onLine) {
      let buf = '';
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (c) => {
        buf += c;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { onLine(buf.slice(0, nl)); buf = buf.slice(nl + 1); }
        if (buf.length > 1_000_000) buf = '';
      });
      child.stdout.on('end', () => { if (buf.trim()) onLine(buf); });
    }
  });
}

// Refreshes a saved login: expiresAt 0 makes Claude Code refresh it before a one-turn haiku call.
// The read-back is saved whatever the exit code (a limited account still rotates its refresh token).
// -> {oauth}; throws when no refreshed login for the same account came back.
export async function refreshLogin(saved, { claude, spawn = cp.spawn, env = process.env, timeoutMs = REFRESH_TIMEOUT_MS, onRateLimit = () => {} } = {}) {
  const cmd = claudeCommand(claude);
  return inTemp(async (dir) => {
    fs.writeFileSync(path.join(dir, '.credentials.json'), JSON.stringify({ claudeAiOauth: { ...saved, expiresAt: 0 } }), { mode: 0o600 });
    const onLine = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev?.type === 'rate_limit_event' && ev.rate_limit_info && typeof ev.rate_limit_info === 'object') {
        try { onRateLimit(ev.rate_limit_info); } catch { /* recording is best effort */ }
      }
    };
    const r = await runChild(spawn, cmd, REFRESH_ARGS, { dir, env, stdio: ['pipe', 'pipe', 'pipe'], input: PROMPT, timeoutMs, onLine });
    const back = readLogin(dir);
    if (!validOauth(back) || back.accountUuid !== saved.accountUuid) {
      throw new Error(`Claude Code did not return a login for this account (${why(r)})`);
    }
    if (!(Number(back.expiresAt) > 0)) throw new Error(`Claude Code did not refresh the login (${why(r)})`);
    return { oauth: back };
  });
}

// Interactive sign-in for `accounts add`: `claude auth login --claudeai [--email e]` with the terminal attached.
// -> {oauth, email}; email from <dir>/.claude.json when Claude Code wrote one.
export async function signIn({ claude, spawn = cp.spawn, env = process.env, email = null, timeoutMs = LOGIN_TIMEOUT_MS } = {}) {
  const cmd = claudeCommand(claude);
  return inTemp(async (dir) => {
    const argv = ['auth', 'login', '--claudeai', ...(email ? ['--email', email] : [])];
    const r = await runChild(spawn, cmd, argv, { dir, env, stdio: 'inherit', timeoutMs });
    const oauth = readLogin(dir);
    if (!validOauth(oauth)) throw new Error(`sign-in did not finish (${why(r)})`);
    let found = null;
    try { found = JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8'))?.oauthAccount?.emailAddress ?? null; } catch { /* none */ }
    return { oauth, email: typeof found === 'string' ? found : null };
  });
}
