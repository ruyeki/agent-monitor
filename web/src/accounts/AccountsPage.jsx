import { useCallback, useEffect, useRef, useState } from 'react';
import { useThrottledTick } from '../hooks.js';
import { relativeTime } from '../lib/time.js';
import { addAccount, cancelSignIn, getAccounts, refreshUsage, sendCode, switchAccount } from './accountsApi.js';
import {
  NAME, dayDate, meterTone, needsAutoRefresh, resetsIn, signInHref, signInRunning, signInText, statusOf, switchBlock,
} from './accountsLib.js';
import './accounts.css';

export const POLL_MS = 1500;
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const NAME_HELP = '1-32 characters: a-z, 0-9 and -, starting with a letter.';

// A clock for the "X ago" / "resets in" words; one per page, so the cards do not each run a timer.
function useNow(ms) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// One usage window as a bar (the Crew tab's context-bar look). Only rendered when the account has a reading.
function Meter({ label, pct, resetsAt, now }) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  const reset = resetsIn(resetsAt, now);
  return (
    <div className="acct-meter">
      <span className="acct-meter-label">{label}</span>
      <span className="acct-bar" role="progressbar" aria-label={`${label} usage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={v} aria-valuetext={`${v}% used`}>
        <b className={meterTone(v)} style={{ width: `${v}%` }} />
      </span>
      <span className="acct-meter-pct">{v}%</span>
      {reset && <span className="acct-meter-reset">{reset}</span>}
    </div>
  );
}

function AccountCard({ a, view }) {
  const { now, enabled, liveRuns, refreshing, switching, onSwitch, error, result } = view;
  const status = statusOf(a, now);
  const hasReading = a.readingAt != null;
  const blocked = switchBlock(a, { now, refreshing });
  const busy = switching === a.name;
  const whyId = `acct-why-${a.name}`;
  return (
    <article className={a.active ? 'card acct on' : 'card acct'} data-account={a.name} aria-labelledby={`acct-name-${a.name}`}>
      <div className="acct-head">
        <span className="acct-av" aria-hidden="true">
          {a.name.slice(0, 1).toUpperCase()}
        </span>
        <div className="acct-who">
          <h2 id={`acct-name-${a.name}`}>{a.name}</h2>
          {a.email && <span className="acct-email">{a.email}</span>}
        </div>
        <div className="acct-pills">
          {a.active && <span className="pill run">Active</span>}
          <span className={`pill ${status.tone}`}>{status.text}</span>
        </div>
      </div>
      {hasReading && (a.fiveHour != null || a.sevenDay != null) && (
        <div className="acct-meters">
          {a.fiveHour != null && <Meter label="5-hour" pct={a.fiveHour} resetsAt={a.fiveHourResetsAt} now={now} />}
          {a.sevenDay != null && <Meter label="7-day" pct={a.sevenDay} resetsAt={a.sevenDayResetsAt} now={now} />}
        </div>
      )}
      {(hasReading || status.tone !== 'idle' || a.refreshExpiresAt) && (
        <p className="acct-facts">
          {a.left != null && <span className="acct-left">{a.left}% left</span>}
          {/* without a reading the status pill may already say so */}
          {hasReading ? <span>Updated {relativeTime(a.readingAt, now)}</span> : status.tone !== 'idle' && <span>No usage reading yet</span>}
          {a.refreshExpiresAt && <span title={new Date(a.refreshExpiresAt).toLocaleString()}>Refresh by {dayDate(a.refreshExpiresAt, now)}</span>}
        </p>
      )}
      {result && (
        <p className={result.ok ? 'acct-result ok' : 'acct-result bad'}>
          {result.ok ? 'Usage refreshed.' : `Refresh failed: ${result.error}`}
        </p>
      )}
      {!result && refreshing && (a.active || a.saved) && (
        <p className="acct-result">
          <span className="ring" aria-hidden="true" /> Refreshing…
        </p>
      )}
      {enabled && a.active && <p className="acct-foot acct-inuse">Claude Code is using this login now.</p>}
      {enabled && !a.active && (
        <div className="acct-foot">
          <button
            type="button"
            className="acct-switch"
            disabled={Boolean(blocked) || switching != null}
            aria-busy={busy || undefined}
            aria-describedby={blocked || liveRuns > 0 ? whyId : undefined}
            onClick={() => onSwitch(a.name)}
          >
            {busy && <span className="ring" aria-hidden="true" />}
            Switch to this account
          </button>
          {busy && (
            <span className="acct-why" role="status">
              Switching…
            </span>
          )}
          {blocked ? (
            <p className="acct-why" id={whyId}>
              {blocked}
            </p>
          ) : (
            liveRuns > 0 && (
              <p className="acct-why acct-live" id={whyId}>
                {plural(liveRuns, 'run is', 'runs are')} working: after a switch, open chats may need "continue".
              </p>
            )
          )}
        </div>
      )}
      {error && (
        <p className="error acct-error" role="alert">
          {error}
        </p>
      )}
    </article>
  );
}

// The add-account panel: the form, then the sign-in's progress (link, code box, Cancel), then how it ended.
function AddPanel({ signIn, mine, onStart, onCode, onCancel, onClose, inputRef }) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [nameError, setNameError] = useState(null);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const running = signInRunning(signIn);
  const shown = running || mine ? signIn : null; // a finished sign-in started elsewhere is not ours to report
  const href = shown?.url ? signInHref(shown.url) : null;

  useEffect(() => {
    if (shown?.state === 'done') {
      setName('');
      setEmail('');
    }
    if (!shown?.needsCode) setCode('');
  }, [shown?.state, shown?.needsCode]);

  const act = async (fn) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e) => {
    e.preventDefault();
    const n = name.trim();
    if (!NAME.test(n)) {
      setNameError(`Give a name of ${NAME_HELP}`);
      inputRef.current?.focus();
      return;
    }
    setNameError(null);
    act(() => onStart(n, email.trim()));
  };
  const submitCode = (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    act(async () => {
      await onCode(code.trim());
      setCode('');
    });
  };

  const ended = shown && !running;
  const cancel = (
    <button type="button" onClick={() => act(onCancel)} disabled={busy || signIn?.state === 'saving'}>
      Cancel
    </button>
  );
  return (
    <section className="card acct-add" id="acct-add" aria-labelledby="acct-add-title">
      <div className="acct-add-head">
        <h2 id="acct-add-title">Add account</h2>
        {!running && (
          <button type="button" className="ghost sm" onClick={onClose}>
            Close
          </button>
        )}
      </div>
      {shown && (
        <div className="acct-progress" role="status" aria-live="polite">
          {running && <span className="ring" aria-hidden="true" />}
          <span className={ended ? (shown.state === 'done' ? 'acct-ok' : shown.state === 'failed' ? 'acct-bad' : '') : ''}>{signInText(shown)}</span>
        </div>
      )}
      {running && (
        <>
          <p className="muted small acct-add-for">
            Signing in as <strong>{signIn.name}</strong>
          </p>
          {href && (
            <a className="acct-signin" href={href} target="_blank" rel="noopener noreferrer">
              Open the sign-in page
            </a>
          )}
          {signIn.state === 'waiting' && signIn.needsCode && (
            <form className="acct-code" onSubmit={submitCode}>
              <div className="field">
                <label htmlFor="acct-code">Paste the code shown after you sign in</label>
                <input
                  id="acct-code"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  autoComplete="off"
                  spellCheck={false}
                  maxLength={500}
                  aria-invalid={signIn.error ? true : undefined}
                  aria-describedby={signIn.error ? 'acct-code-error' : undefined}
                />
              </div>
              {signIn.error && (
                <p className="error" id="acct-code-error" role="alert">
                  {signIn.error}
                </p>
              )}
              <div className="acct-add-actions">
                <button type="submit" className="primary" disabled={busy || !code.trim()}>
                  Send code
                </button>
                {cancel}
              </div>
            </form>
          )}
          {!(signIn.state === 'waiting' && signIn.needsCode) && <div className="acct-add-actions">{cancel}</div>}
        </>
      )}
      {!running && (
        <form className="acct-form" onSubmit={submit} noValidate>
          <div className="acct-form-fields">
            <div className="field">
              <label htmlFor="acct-name">Name</label>
              <input
                id="acct-name"
                ref={inputRef}
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                maxLength={32}
                aria-invalid={nameError ? true : undefined}
                aria-describedby="acct-name-help"
              />
              <span id="acct-name-help" className={nameError ? 'error small' : 'muted small'}>
                {nameError || NAME_HELP}
              </span>
            </div>
            <div className="field">
              <label htmlFor="acct-email">Email (optional)</label>
              <input id="acct-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="off" spellCheck={false} maxLength={254} />
              <span className="muted small">Only this address is accepted at sign-in.</span>
            </div>
          </div>
          <div className="acct-add-actions">
            <button type="submit" className="primary" disabled={busy}>
              Start sign-in
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

export function AccountsPage({ tick, pollMs = POLL_MS }) {
  const t = useThrottledTick(tick, 3000);
  const now = useNow(15_000);
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [stamp, setStamp] = useState(0); // bumps after every load attempt: the poll schedules its next call from it
  const [switching, setSwitching] = useState(null);
  const [switchErrors, setSwitchErrors] = useState({});
  const [notice, setNotice] = useState(null);
  const [refreshPosting, setRefreshPosting] = useState(false);
  const [refreshError, setRefreshError] = useState(null);
  const [watchedRefresh, setWatchedRefresh] = useState(false); // per-account results show only for a refresh seen on this page
  const [addOpen, setAddOpen] = useState(false);
  const [myJob, setMyJob] = useState(null);
  const alive = useRef(true);
  const seq = useRef(0);
  const autoChecked = useRef(false);
  const nameRef = useRef(null);
  const addBtn = useRef(null);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    const n = ++seq.current;
    try {
      const d = await getAccounts();
      if (!alive.current || n !== seq.current) return;
      setData(d);
      setLoadError(null);
      if (d?.refresh?.running) setWatchedRefresh(true);
    } catch (e) {
      if (alive.current && n === seq.current) setLoadError(e.message);
    } finally {
      if (alive.current) setStamp((s) => s + 1);
    }
  }, []);

  useEffect(() => {
    load();
  }, [t, load]);

  const enabled = Boolean(data?.enabled);
  const refreshing = Boolean(data?.refresh?.running);
  const signIn = data?.signIn ?? null;
  const signingIn = signInRunning(signIn);
  const polling = refreshing || signingIn;

  // Poll only while a refresh or a sign-in runs; otherwise the live tick refetches.
  useEffect(() => {
    if (!polling) return undefined;
    const id = setTimeout(load, pollMs);
    return () => clearTimeout(id);
  }, [polling, stamp, load, pollMs]);

  const startRefresh = useCallback(async () => {
    setRefreshPosting(true);
    setRefreshError(null);
    setWatchedRefresh(true);
    try {
      await refreshUsage();
    } catch (e) {
      if (e.status !== 409 && alive.current) setRefreshError(e.message); // 409: one is already running, so just follow it
    } finally {
      await load(); // stay busy until the page shows the job, so the button cannot flicker back on
      if (alive.current) setRefreshPosting(false);
    }
  }, [load]);

  // Once per page open, after the first load: refresh when a reading is older than 30 minutes.
  useEffect(() => {
    if (!data || autoChecked.current) return;
    autoChecked.current = true;
    if (needsAutoRefresh(data, Date.now())) startRefresh();
  }, [data, startRefresh]);

  const onSwitch = async (name) => {
    setSwitching(name);
    setSwitchErrors({});
    setNotice(null);
    try {
      const r = await switchAccount(name);
      if (alive.current) setNotice(r?.switched === false ? `Already on "${name}".` : `Switched to "${name}".`);
    } catch (e) {
      if (alive.current) setSwitchErrors({ [name]: e.message });
    } finally {
      await load();
      if (alive.current) setSwitching(null);
    }
  };

  const onStart = async (name, email) => {
    try {
      const r = await addAccount(name, email);
      if (r?.signIn) setMyJob(`${r.signIn.name}@${r.signIn.startedAt}`);
    } finally {
      await load(); // the panel stays busy until it shows the new sign-in state
    }
  };
  const onCode = async (code) => {
    try {
      await sendCode(code);
    } finally {
      await load();
    }
  };
  const onCancel = async () => {
    try {
      await cancelSignIn();
    } finally {
      await load();
    }
  };
  const closeAdd = () => {
    setAddOpen(false);
    setMyJob(null);
    addBtn.current?.focus();
  };
  const toggleAdd = () => {
    if (addOpen) return closeAdd();
    setAddOpen(true);
    setMyJob(null);
  };
  useEffect(() => {
    if (addOpen) nameRef.current?.focus(); // the form opens with the name box focused
  }, [addOpen]);

  const accounts = data?.accounts ?? [];
  const results = watchedRefresh ? data?.refresh?.results ?? [] : [];
  const resultOf = (name) => results.find((r) => r.name === name) ?? null;
  const generalErrors = results.filter((r) => r.name == null && !r.ok);
  const mine = Boolean(signIn) && myJob === `${signIn.name}@${signIn.startedAt}`;
  const panel = enabled && (addOpen || signingIn);
  const view = { now, enabled, liveRuns: data?.liveRuns ?? 0, refreshing, switching, onSwitch, error: null, result: null };

  return (
    <div className="acct-page">
      <header className="page-head">
        <div className="hgroup">
          <h1>Accounts</h1>
          {data && enabled && <span className="muted small">{plural(accounts.length, 'Claude login', 'Claude logins')}</span>}
        </div>
        {enabled && (
          <div className="hgroup acct-head-actions">
            {(refreshing || refreshPosting) && (
              <span className="muted small" role="status">
                Refreshing usage…
              </span>
            )}
            {!refreshing && !refreshPosting && data?.refresh?.at && (
              <span className="muted small">Last refreshed {relativeTime(data.refresh.at, now)}</span>
            )}
            <button type="button" onClick={startRefresh} disabled={refreshing || refreshPosting} aria-busy={refreshing || refreshPosting || undefined}>
              {(refreshing || refreshPosting) && <span className="ring" aria-hidden="true" />}
              Refresh usage
            </button>
            <button
              type="button"
              className="primary"
              ref={addBtn}
              onClick={toggleAdd}
              disabled={signingIn}
              aria-expanded={panel}
              aria-controls={panel ? 'acct-add' : undefined}
            >
              Add account
            </button>
          </div>
        )}
      </header>
      {loadError && (
        <p className="error" role="alert">
          Could not load accounts: {loadError}
        </p>
      )}
      {data && !enabled && (
        <p className="acct-notice">Account switching is turned off on this machine (AGENT_MONITOR_ACCOUNTS=off), so this page is read-only.</p>
      )}
      {enabled && data.liveReason && <p className="acct-notice warn">Cannot tell which account is live: {data.liveReason}</p>}
      {refreshError && (
        <p className="error" role="alert">
          {refreshError}
        </p>
      )}
      {generalErrors.map((r, i) => (
        <p key={i} className="error" role="alert">
          Refresh failed: {r.error}
        </p>
      ))}
      {notice && (
        <p className="acct-notice ok" role="status">
          {notice}
        </p>
      )}
      {panel && <AddPanel signIn={signIn} mine={mine} onStart={onStart} onCode={onCode} onCancel={onCancel} onClose={closeAdd} inputRef={nameRef} />}
      {data && enabled && accounts.length === 0 && <p className="muted empty">No accounts yet. Use "Add account" to sign one in.</p>}
      {accounts.length > 0 && (
        <section className="acct-grid" aria-label="Accounts">
          {accounts.map((a) => (
            <AccountCard key={a.name} a={a} view={{ ...view, error: switchErrors[a.name] ?? null, result: resultOf(a.name) }} />
          ))}
        </section>
      )}
    </div>
  );
}
