// In-browser sign-in for the Accounts page: `claude auth login --claudeai [--email e]` with piped stdio in a temp profile.
// Claude Code 2.1.x prints "If the browser didn't open, visit: <url>" and "Paste code here if prompted > ", reads the code
// (code#state) from stdin, and exits 0 once the login is written ("Invalid code..." on stderr keeps it waiting). It also
// listens on 127.0.0.1 for the browser's own redirect, so a sign-in in the tab it opened finishes with no code at all.
// Only an https link on an Anthropic host is taken from that output; nothing else it prints leaves this module.
import cp from 'node:child_process';
import { claudeCommand, inTemp, runChild, signInResult, loginArgs, LOGIN_TIMEOUT_MS } from './refresh.js';

const HOSTS = ['anthropic.com', 'claude.ai', 'claude.com'];
const MAX_URL = 2048;
const KEEP = 16_384; // chars of recent output kept for scanning
const PROMPT = /paste (the )?code/i;
const INVALID = /invalid code/i;

// s as a URL when it is https on an Anthropic host (or a subdomain), with no user, password or port; else null.
export function allowedUrl(s) {
  if (typeof s !== 'string' || s.length > MAX_URL) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  return HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? u.href : null;
}

// The first allowed link in text. A link counts only once whitespace follows it, so one cut by a chunk edge waits.
export function findSignInUrl(text) {
  for (const m of String(text).matchAll(/https:\/\/[^\s"'<>`]+(?=\s)/g)) {
    const url = allowedUrl(m[0]);
    if (url) return url;
  }
  return null;
}

// Starts the sign-in. -> {view(), sendCode(code), cancel(), done}. view = {phase, url, needsCode, error}, phase
// starting -> waiting (link or prompt seen) -> checking (code sent) -> saving (a login came back); onUpdate gets each change.
// done -> {oauth, email} (signInResult); it rejects on cancel, timeout or a failed sign-in, and the temp profile is always removed.
export function startSignIn({ claude, spawn = cp.spawn, env = process.env, email = null, timeoutMs = LOGIN_TIMEOUT_MS, onUpdate = () => {} } = {}) {
  const cmd = claudeCommand(claude);
  const view = { phase: 'starting', url: null, needsCode: false, error: null };
  let child = null;
  let cancelled = false;
  let seen = '';
  let sinceCode = null; // output since the last code was written; null while none is being checked
  const set = (patch) => { Object.assign(view, patch); try { onUpdate({ ...view }); } catch { /* the page is told best effort */ } };

  const onText = (chunk) => {
    seen = (seen + chunk).slice(-KEEP);
    const patch = {};
    if (!view.url) { const url = findSignInUrl(seen); if (url) patch.url = url; }
    if (sinceCode != null) {
      sinceCode = (sinceCode + chunk).slice(-KEEP);
      // Rejected locally (or asked again): let the code be pasted again.
      if (INVALID.test(sinceCode) || PROMPT.test(sinceCode)) {
        sinceCode = null;
        Object.assign(patch, { phase: 'waiting', needsCode: true, error: 'That code was not accepted. Copy the whole code from the sign-in page and paste it again.' });
      }
    } else if (view.phase === 'starting' && (patch.url || PROMPT.test(seen))) {
      Object.assign(patch, { phase: 'waiting', needsCode: PROMPT.test(seen) });
    } else if (view.phase === 'waiting' && !view.needsCode && PROMPT.test(seen)) patch.needsCode = true;
    if (Object.keys(patch).length) set(patch);
  };

  const onSpawn = (c) => { child = c; if (cancelled) { try { c.kill(); } catch { /* gone */ } } };
  const done = inTemp(async (dir) => {
    const r = await runChild(spawn, cmd, loginArgs(email), { dir, env, stdio: ['pipe', 'pipe', 'pipe'], timeoutMs, onText, onSpawn });
    if (cancelled) throw new Error('the sign-in was cancelled; nothing was saved');
    if (r.timedOut) throw new Error('the sign-in took too long and was stopped; nothing was saved');
    const login = signInResult(dir, r, email);
    set({ phase: 'saving', needsCode: false, error: null });
    return login;
  });

  return {
    view: () => ({ ...view }),
    // Writes one line to Claude Code's prompt. -> false when it is not waiting for a code.
    sendCode(code) {
      if (cancelled || view.phase !== 'waiting' || !view.needsCode || !child?.stdin?.writable) return false;
      child.stdin.write(`${code}\n`);
      sinceCode = '';
      set({ phase: 'checking', needsCode: false, error: null });
      return true;
    },
    // Kills Claude Code; done then rejects and nothing is saved. -> false once a login came back (it is being saved).
    cancel() {
      if (view.phase === 'saving') return false;
      cancelled = true;
      try { child?.kill(); } catch { /* gone */ }
      return true;
    },
    done,
  };
}
