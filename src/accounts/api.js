// HTTP API for the Accounts page (/api/accounts*, contract C11): accounts with usage, a one-click switch, a usage
// refresh job and an in-browser sign-in job (signin.js). Responses carry only the fields listed in C11: never a token,
// an account id, a raw reading, or anything Claude Code printed except the checked sign-in link.
import { NAME } from './state.js';

const MAX_BODY = 4096;
const MAX_CODE = 500;
const MAX_EMAIL = 254;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
const RUNNING = new Set(['starting', 'waiting', 'checking', 'saving']);
const OFF = 'Account switching is turned off on this machine (AGENT_MONITOR_ACCOUNTS=off), so accounts cannot be changed here.';
const BAD_NAME = 'Give an account name of 1-32 characters: a-z, 0-9 and -, starting with a letter.';

const iso = (ms) => new Date(ms).toISOString();
const plain = (e) => String(e?.message ?? e ?? 'something went wrong').slice(0, 300);

function send(res, status, body, close = false) {
  const data = JSON.stringify(body);
  const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' };
  if (close) headers.Connection = 'close'; // body left unread: drop the connection
  res.writeHead(status, headers);
  res.end(data);
}

// 'no-login' (no saved login) | 'limited' (a limit in force, or a window at 100%) | 'no-reading' | 'available'.
export function statusOf(r) {
  if (!r.saved) return 'no-login';
  if (r.limitedUntil != null || (r.reading && r.left <= 0)) return 'limited';
  return r.reading ? 'available' : 'no-reading';
}

// A manager.list() row -> the page's account (C11). left is null without a reading (list() says 100 then).
export function accountView(r) {
  return {
    name: r.name, email: r.email ?? null, active: Boolean(r.active), saved: Boolean(r.saved), status: statusOf(r),
    fiveHour: r.fiveHour ?? null, sevenDay: r.sevenDay ?? null, fiveHourResetsAt: r.fiveHourResetsAt ?? null,
    sevenDayResetsAt: r.sevenDayResetsAt ?? null, left: r.reading ? r.left : null, limitedUntil: r.limitedUntil ?? null,
    refreshExpiresAt: r.refreshExpiresAt ?? null, readingAt: r.reading?.at ?? null,
  };
}

// manager: createAccounts() or null (accounts off). emit(): tell the app a 'usage' change happened. liveRuns(): working runs.
// -> {handle(req, res, url, readJson) -> true when it answered an /api/accounts* request, close()}.
export function createAccountsApi({ manager = null, clock = Date.now, emit = () => {}, liveRuns = () => 0, loginTimeoutMs } = {}) {
  let refresh = null; // {running, at, results:[{name, ok, error}]}: at = start while running, end once done
  let signIn = null; // the last sign-in's view (C11), kept after it ends so the page can show how it went
  let session = null; // the sign-in still running (until its done settles): {job, sendCode, cancel}
  const changed = () => { try { emit(); } catch { /* best effort */ } };
  const runs = () => { try { return Number(liveRuns()) || 0; } catch { return 0; } };

  function state() {
    if (!manager) return { enabled: false, accounts: [], liveReason: null, liveRuns: runs(), refresh: null, signIn: null };
    return {
      enabled: true, accounts: manager.list().map(accountView), liveReason: manager.liveReason() ?? null, liveRuns: runs(),
      refresh: refresh && { ...refresh, results: refresh.results.map((r) => ({ ...r })) }, signIn: signIn && { ...signIn },
    };
  }

  // Saved non-live accounts through refresh(name) (temp profile), the live one through readActive (never a forced token refresh).
  async function runRefresh(job) {
    try {
      const rows = manager.list().filter((r) => r.active || r.saved).sort((a, b) => Number(b.active) - Number(a.active));
      for (const r of rows) {
        try {
          await (r.active ? manager.readActive() : manager.refresh(r.name));
          job.results.push({ name: r.name, ok: true, error: null });
        } catch (e) { job.results.push({ name: r.name, ok: false, error: plain(e) }); }
        changed();
      }
    } catch (e) { job.results.push({ name: null, ok: false, error: plain(e) }); }
    job.running = false;
    job.at = iso(clock());
    changed();
  }

  function startAdd(name, email) {
    const job = { state: 'starting', name, url: null, needsCode: false, error: null, startedAt: iso(clock()) };
    let stopped = false;
    const onUpdate = (v) => {
      if (stopped || !RUNNING.has(job.state)) return;
      Object.assign(job, { state: v.phase, url: v.url, needsCode: v.needsCode, error: v.error });
      changed();
    };
    const s = manager.startSignIn(name, { email, timeoutMs: loginTimeoutMs, onUpdate });
    const end = (st, error) => {
      Object.assign(job, { state: st, url: null, needsCode: false, error });
      if (session?.job === job) session = null;
      changed();
    };
    s.done.then(() => end('done', null), (e) => end(stopped ? 'cancelled' : 'failed', stopped ? null : plain(e)));
    signIn = job;
    session = {
      job,
      sendCode: (code) => s.sendCode(code),
      cancel() {
        if (!s.cancel()) return false;
        stopped = true;
        Object.assign(job, { state: 'cancelled', url: null, needsCode: false, error: null });
        changed();
        return true;
      },
    };
    changed();
  }

  async function post(res, path, b) {
    if (path === '/api/accounts/use') {
      if (typeof b.name !== 'string' || !NAME.test(b.name)) return send(res, 400, { error: BAD_NAME });
      if (!manager.list().some((r) => r.name === b.name)) return send(res, 404, { error: `There is no account named "${b.name}".` });
      try {
        const r = await manager.use(b.name, { reason: 'manual' });
        changed();
        return send(res, 200, { from: r.from ?? null, to: r.to, switched: Boolean(r.switched) });
      } catch (e) { return send(res, 400, { error: plain(e) }); }
    }
    if (path === '/api/accounts/refresh') {
      if (refresh?.running) return send(res, 409, { error: 'Usage is already being refreshed; wait for it to finish.' });
      const job = { running: true, at: iso(clock()), results: [] };
      refresh = job;
      changed();
      runRefresh(job);
      return send(res, 202, { refresh: { ...job, results: [] } });
    }
    if (path === '/api/accounts/add') {
      if (session) return send(res, 409, { error: 'A sign-in is already running; finish or cancel it first.' });
      if (typeof b.name !== 'string' || !NAME.test(b.name)) return send(res, 400, { error: BAD_NAME });
      const email = b.email == null || b.email === '' ? null : b.email;
      if (email != null && (typeof email !== 'string' || email.length > MAX_EMAIL || !EMAIL.test(email))) {
        return send(res, 400, { error: 'That email address does not look right; leave it empty or give one like name@example.com.' });
      }
      try { startAdd(b.name, email); } catch (e) {
        signIn = { state: 'failed', name: b.name, url: null, needsCode: false, error: plain(e), startedAt: iso(clock()) };
        return send(res, 400, { error: signIn.error });
      }
      return send(res, 202, { signIn: { ...signIn } });
    }
    if (path === '/api/accounts/add/code') {
      if (!session || session.job.state !== 'waiting' || !session.job.needsCode) return send(res, 409, { error: 'No sign-in is waiting for a code.' });
      const code = typeof b.code === 'string' ? b.code.trim() : '';
      if (!code || code.length > MAX_CODE || CONTROL.test(code)) return send(res, 400, { error: `Paste the code as one line of at most ${MAX_CODE} characters.` });
      if (!session.sendCode(code)) return send(res, 409, { error: 'No sign-in is waiting for a code.' });
      return send(res, 200, { signIn: { ...signIn } });
    }
    if (path === '/api/accounts/add/cancel') {
      if (!session) return send(res, 409, { error: 'No sign-in is running.' });
      if (!session.cancel()) return send(res, 409, { error: 'The sign-in already finished and the login is being saved.' });
      return send(res, 200, { signIn: { ...signIn } });
    }
    return send(res, 404, { error: 'Not found.' });
  }

  async function handle(req, res, url, readJson) {
    const path = url.pathname;
    if (path !== '/api/accounts' && !path.startsWith('/api/accounts/')) return false;
    if (req.method === 'GET' && path === '/api/accounts') {
      try { send(res, 200, state()); } catch (e) { send(res, 500, { error: plain(e) }); }
      return true;
    }
    if (req.method !== 'POST') { send(res, 404, { error: 'Not found.' }); return true; }
    if (Number(req.headers['content-length']) > MAX_BODY) { send(res, 413, { error: 'Body too large.' }, true); return true; }
    const b = await readJson();
    if (!b || typeof b !== 'object' || Array.isArray(b)) { send(res, 400, { error: 'Send a JSON object.' }); return true; }
    if (!manager) { send(res, 409, { error: OFF }); return true; }
    try { await post(res, path, b); } catch (e) { if (!res.headersSent) send(res, 500, { error: plain(e) }); }
    return true;
  }

  // Stops a running sign-in (its temp profile is removed when Claude Code exits).
  const close = () => { try { session?.cancel(); } catch { /* closing is best effort */ } };

  return { handle, close };
}
