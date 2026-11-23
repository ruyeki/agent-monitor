// Pure helpers for the Accounts page: status words, why a switch is blocked, staleness, times. No React here.
import { formatElapsed } from '../lib/format.js';

export const NAME = /^[a-z][a-z0-9-]{0,31}$/; // the server's account name rule (src/accounts/state.js)
export const STALE_MS = 30 * 60_000;
const RUNNING = new Set(['starting', 'waiting', 'checking', 'saving']);
const SIGN_IN_HOSTS = ['anthropic.com', 'claude.ai', 'claude.com'];

// The API sends reset/limit times as epoch ms and reading/refresh times as ISO strings.
export function msOf(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v !== 'string') return null;
  const n = Date.parse(v);
  return Number.isNaN(n) ? null : n;
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

// A local wall-clock time: "14:30" today, "Thu 14:30" within a week, "18 Dec, 14:30" further out.
export function clockTime(v, now = Date.now()) {
  const ms = msOf(v);
  if (ms == null) return '-';
  const d = new Date(ms);
  const time = { hour: '2-digit', minute: '2-digit' };
  if (sameDay(d, new Date(now))) return d.toLocaleTimeString(undefined, time);
  if (Math.abs(ms - now) < 6 * 86400_000) return d.toLocaleString(undefined, { weekday: 'short', ...time });
  return d.toLocaleString(undefined, { day: 'numeric', month: 'short', ...time });
}

// A calendar date: "18 Dec" this year, "18 Dec 2027" otherwise.
export function dayDate(v, now = Date.now()) {
  const ms = msOf(v);
  if (ms == null) return '-';
  const d = new Date(ms);
  const opts = { day: 'numeric', month: 'short', ...(d.getFullYear() === new Date(now).getFullYear() ? {} : { year: 'numeric' }) };
  return d.toLocaleDateString(undefined, opts);
}

export function resetsIn(v, now = Date.now()) {
  const ms = msOf(v);
  if (ms == null) return null;
  return ms <= now ? 'resets now' : `resets in ${formatElapsed(ms - now)}`;
}

// When a limited account frees up: the recorded limit, else the latest reset of a window that is full.
export function limitEnd(a) {
  if (msOf(a.limitedUntil) != null) return msOf(a.limitedUntil);
  const full = [[a.fiveHour, a.fiveHourResetsAt], [a.sevenDay, a.sevenDayResetsAt]].filter(([p, r]) => p != null && p >= 100 && msOf(r) != null);
  return full.length ? Math.max(...full.map(([, r]) => msOf(r))) : null;
}

// A saved login whose refresh token has expired cannot be used until it is added again.
export const loginExpired = (a, now = Date.now()) => Boolean(a.saved) && msOf(a.refreshExpiresAt) != null && msOf(a.refreshExpiresAt) <= now;

// -> {text, tone}; tone is a pill class (done | wait | idle | fail).
export function statusOf(a, now = Date.now()) {
  if (a.status === 'no-login') return { text: 'No saved login', tone: 'fail' };
  if (loginExpired(a, now)) return { text: 'Login needs re-adding', tone: 'fail' };
  if (a.status === 'limited') {
    const end = limitEnd(a);
    return { text: end != null ? `Limited until ${clockTime(end, now)}` : 'Limited', tone: 'wait' };
  }
  if (a.status === 'no-reading') return { text: 'No usage reading yet', tone: 'idle' };
  return { text: 'Available', tone: 'done' };
}

// Why "Switch to this account" is disabled, in plain words, or null when it may be clicked.
export function switchBlock(a, { now = Date.now(), refreshing = false } = {}) {
  if (a.status === 'no-login') return 'No saved login: add this account again to use it.';
  if (loginExpired(a, now)) return `Its login expired on ${dayDate(a.refreshExpiresAt, now)}: add this account again to use it.`;
  if (a.status === 'limited') {
    const end = limitEnd(a);
    return end != null ? `Out of usage until ${clockTime(end, now)}.` : 'Out of usage for now.';
  }
  if (refreshing) return 'Wait for the usage refresh to finish.';
  return null;
}

// Auto refresh on page open: only when an account that can be refreshed has a reading older than 30 minutes. Missing
// readings alone do not count (an account that never gets one would refresh on every visit).
export function needsAutoRefresh(data, now = Date.now()) {
  if (!data?.enabled || data.refresh?.running) return false;
  return (data.accounts ?? []).some((a) => (a.active || a.saved) && msOf(a.readingAt) != null && now - msOf(a.readingAt) > STALE_MS);
}

export const signInRunning = (s) => Boolean(s) && RUNNING.has(s.state);

// The sign-in link only when it is https on an Anthropic host (the server checks this too).
export function signInHref(u) {
  let url;
  try {
    url = new URL(u);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  return SIGN_IN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url.href : null;
}

// One line for where a sign-in stands.
export function signInText(s) {
  if (!s) return '';
  if (s.state === 'starting') return 'Starting the Claude Code sign-in…';
  if (s.state === 'waiting') {
    if (!s.url && s.needsCode) return 'Claude Code is asking for a code but gave no sign-in link this page can trust. Cancel, then try again.';
    if (!s.url) return 'Waiting for the sign-in link…';
    return s.needsCode
      ? 'Open the sign-in page, approve access, then paste the code it shows below.'
      : 'Open the sign-in page and approve access. This page updates when you are done.';
  }
  if (s.state === 'checking') return 'Checking the code…';
  if (s.state === 'saving') return 'Signed in. Saving the login…';
  if (s.state === 'done') return `Added "${s.name}".`;
  if (s.state === 'cancelled') return 'Sign-in cancelled. Nothing was saved.';
  if (s.state === 'failed') return `Sign-in failed: ${(s.error || 'something went wrong').replace(/[.\s]+$/, '')}. Nothing was saved.`;
  return '';
}

export const meterTone = (pct) => (pct >= 100 ? 'full' : pct >= 80 ? 'high' : '');
