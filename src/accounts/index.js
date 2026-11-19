// Claude accounts manager: saved logins (vault), usage per account, swapping the live login, limit hand-offs,
// refreshes through Claude Code and saving rotated tokens back from the live file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import cp from 'node:child_process';
import { NAME, loadRegistry, saveRegistry, readUsage, writeUsage, removeUsage, withLock } from './state.js';
import { readCredsText, parseCreds, liveIdentity, parseOauth, validOauth, applySwap, credsPath } from './creds.js';
import { usageLeft, windowPct, limitedUntil, isAvailable, pickBest as best, attribute, toSecs, toMs, fromRateLimitInfo } from './usage.js';
import { recordWindows } from './record.js';
import { refreshLogin, signIn } from './refresh.js';

const DUPLICATE_MS = 120_000;
const MAX_LIMIT_S = 7 * 86400; // a recorded reset is at most a week after the hit (a forged far-future one cannot park an account)
const LIMIT_WAIT_MS = 150_000; // longer than a refresh (120 s) holds the lock, so a limit during one waits instead of going to Codex
const REFRESH_AHEAD_MS = 7 * 86400_000;
const REFRESH_EVERY_MS = 6 * 3600_000;
const capReset = (secs, atMs) => (secs == null ? null : Math.min(secs, Math.floor(atMs / 1000) + MAX_LIMIT_S));
const iso = (ms) => new Date(ms).toISOString();
const isoOrNull = (v) => { const ms = toMs(v); return ms == null || ms <= 0 ? null : iso(ms); };
const key = (name) => `account/${name}`;
const hash = (o) => crypto.createHash('sha256').update(JSON.stringify(o)).digest('hex');

function checkName(name) {
  if (typeof name !== 'string' || !NAME.test(name)) throw new Error(`invalid account name "${String(name).slice(0, 40)}" (a-z, 0-9, -; starts with a letter)`);
  return name;
}

export function createAccounts({ dataDir, home, claudeJson = path.join(home, '.claude.json'), vault, claude = null, spawn = cp.spawn, clock = Date.now, env = process.env, limitWaitMs = LIMIT_WAIT_MS } = {}) {
  const saved = new Map(); // name -> hash of the login last written to or read from the vault (sync-back skips equal ones)
  let timers = [];
  let watcher = null;
  let debounce = null;

  const registry = () => loadRegistry(dataDir);
  const nameFor = (reg, uuid) => (uuid ? Object.keys(reg.accounts).find((n) => reg.accounts[n].accountUuid === uuid) ?? null : null);
  const identity = (reg) => liveIdentity({ home, claudeJson, reg });
  const activeOf = (reg) => nameFor(reg, identity(reg).accountUuid);
  // Why the live login's account is unknown (tokens but no usable account id), else null.
  const liveReason = () => { try { return identity(registry()).reason; } catch { return null; } };
  const need = (reg, name) => { if (!reg.accounts[checkName(name)]) throw new Error(`no account named "${name}"`); return reg.accounts[name]; };
  const accountsOf = (reg) => Object.keys(reg.accounts).map((n) => ({ name: n, saved: Boolean(reg.accounts[n].savedAt), usage: readUsage(dataDir, n) }));
  const usages = (names) => Object.fromEntries(names.map((n) => [n, readUsage(dataDir, n)]));
  // The registered account a reading or hit with this reset time belongs to (see usage.js attribute).
  const owner = (reg, active, secs) => attribute(Object.keys(reg.accounts), active, usages(Object.keys(reg.accounts)), secs);

  function activeName() {
    try { return activeOf(registry()); } catch { return null; }
  }
  const hasAccounts = () => { try { return Object.keys(registry().accounts).length > 0; } catch { return false; } };

  // Marks name's saved login fresh in the registry (caller holds the lock).
  function markSaved(reg, name, oauth) {
    const a = reg.accounts[name];
    if (!a) return;
    a.savedAt = iso(clock());
    a.refreshExpiresAt = isoOrNull(oauth.refreshTokenExpiresAt);
    saved.set(name, hash(oauth));
  }

  // Rows for `accounts list`; reads the registry, usage files and the live file, never the vault.
  function list() {
    const reg = registry();
    const now = clock();
    const active = activeOf(reg);
    return Object.keys(reg.accounts).sort().map((name) => {
      const a = reg.accounts[name];
      const { reading, limit } = readUsage(dataDir, name);
      const until = limitedUntil(limit);
      const pct = (w) => (w ? windowPct(w, now) : null);
      const resets = (w) => (Number.isFinite(w?.resets_at) && w.resets_at * 1000 > now ? w.resets_at * 1000 : null);
      return {
        name, email: a.email ?? null, accountUuid: a.accountUuid, active: name === active, saved: Boolean(a.savedAt), reading, limit,
        fiveHour: pct(reading?.five_hour), sevenDay: pct(reading?.seven_day), fiveHourResetsAt: resets(reading?.five_hour),
        sevenDayResetsAt: resets(reading?.seven_day), left: usageLeft(reading, now), limitedUntil: until != null && now < until ? until : null,
        available: isAvailable({ name, saved: Boolean(a.savedAt), usage: { reading, limit } }, now),
        refreshExpiresAt: a.refreshExpiresAt ?? null,
      };
    });
  }

  async function add(name, { current = false, email = null } = {}) {
    checkName(name);
    let oauth;
    let found = null;
    if (current) {
      const id = identity(registry());
      if (id.reason) throw new Error(id.reason);
      ({ oauth, email: found } = id);
    } else ({ oauth, email: found } = await signIn({ claude, spawn, env, email }));
    if (!validOauth(oauth)) throw new Error(current ? 'there is no usable live login to save' : 'the sign-in returned no usable login');
    return withLock(dataDir, async () => {
      const reg = registry();
      const other = nameFor(reg, oauth.accountUuid);
      if (other && other !== name) throw new Error(`that login is already saved as "${other}"`);
      const old = reg.accounts[name];
      if (old && old.accountUuid !== oauth.accountUuid) throw new Error(`"${name}" is a different account; remove it first`);
      await vault.set(key(name), JSON.stringify(oauth));
      const now = iso(clock());
      reg.accounts[name] = { accountUuid: oauth.accountUuid, email: found ?? email ?? old?.email ?? null, addedAt: old?.addedAt ?? now, savedAt: null, refreshExpiresAt: null };
      markSaved(reg, name, oauth);
      saveRegistry(dataDir, reg);
      return { name, email: reg.accounts[name].email, accountUuid: oauth.accountUuid };
    });
  }

  // The swap itself (caller holds the lock). Any failure before the write leaves .credentials.json untouched.
  // A live Claude process may rotate the token while the (slow) vault batch runs, so the file is re-read right before the
  // write; a changed file is saved again (same account only), at most 3 times.
  async function swap(name, reason) {
    const reg = registry();
    const entry = need(reg, name);
    let first;
    for (let attempt = 0; ; attempt++) {
      const curText = readCredsText(home);
      parseCreds(curText); // a corrupt file stops here, before any vault write
      const id = identity(reg);
      if (id.reason) throw new Error(`cannot tell which account the live login is: ${id.reason}; not switching`);
      const curOauth = id.oauth;
      const from = nameFor(reg, curOauth?.accountUuid);
      // A login nobody saved would survive only in `backup`, which the next swap overwrites.
      if (curOauth && !from) throw new Error('the live login is not a saved account; save it first: agent-monitor accounts add <name> --current');
      if (attempt === 0) first = from;
      else if (from !== first) throw new Error('the live login changed while switching; try again');
      const keys = from && from !== name ? [key(name), key(from)] : [key(name)];
      const got = await vault.getMany(keys);
      const writes = {};
      if (from && JSON.stringify(curOauth) !== got[key(from)]) writes[key(from)] = JSON.stringify(curOauth);
      else if (from) saved.set(from, hash(curOauth));
      if (from === name) {
        // Already live: the live file is newer than the vault, so only save it back.
        if (writes[key(from)]) { await vault.setMany(writes); markSaved(reg, from, curOauth); saveRegistry(dataDir, reg); }
        return { from, to: name, switched: false };
      }
      const target = parseOauth(got[key(name)]);
      if (!target) {
        entry.savedAt = null;
        saveRegistry(dataDir, reg);
        throw new Error(`no saved login for "${name}"; run: agent-monitor accounts add ${name}`);
      }
      if (target.accountUuid !== entry.accountUuid) throw new Error(`the saved login for "${name}" belongs to another account`);
      if (curText != null) writes.backup = curText;
      await vault.setMany(writes);
      if (writes[key(from)]) markSaved(reg, from, curOauth);
      if (readCredsText(home) !== curText) {
        if (attempt >= 3) throw new Error('the live login keeps changing; try again');
        continue;
      }
      applySwap(home, curText, target);
      saved.set(name, hash(target));
      reg.lastSwitch = { from, to: name, at: iso(clock()), reason };
      saveRegistry(dataDir, reg);
      return { from, to: name, switched: true };
    }
  }

  const use = (name, { reason = 'manual', waitMs } = {}) => withLock(dataDir, () => swap(checkName(name), reason), waitMs == null ? {} : { waitMs });

  async function remove(name) {
    return withLock(dataDir, async () => {
      const reg = registry();
      need(reg, name);
      await vault.delete(key(name));
      delete reg.accounts[name];
      saved.delete(name);
      saveRegistry(dataDir, reg);
      removeUsage(dataDir, name);
      return { name };
    });
  }

  // reading {five_hour, seven_day} (statusline windows); name null = attribute by five_hour.resets_at.
  // Never throws; -> the account it was recorded on, or null.
  function recordReading(name, reading) {
    try { return recordWindows({ dataDir, home, claudeJson, name, reading, now: clock() }); } catch { return null; }
  }

  // A hit without a reset time keeps a stored limit that is still in force (it would only lose information).
  function recordLimit(name, { at, resetsAt = null } = {}) {
    try {
      if (!name || !registry().accounts[name]) return false;
      const u = readUsage(dataDir, name);
      const atMs = toMs(at) ?? clock();
      const secs = capReset(toSecs(resetsAt), atMs);
      if (secs == null && (limitedUntil(u.limit) ?? 0) > atMs) return true;
      writeUsage(dataDir, name, { ...u, limit: { at: iso(atMs), resetsAt: secs } });
      return true;
    } catch { return false; }
  }

  // A stream-json rate_limit_info: its windows as a reading, and a limit when status is rejected. Sync, never throws.
  function recordRateLimit(name, info) {
    try {
      const target = recordReading(name, fromRateLimitInfo(info)) ?? name ?? activeName();
      if (info?.status === 'rejected') recordLimit(target, { at: clock(), resetsAt: Number.isFinite(info.resetsAt) ? info.resetsAt : null });
    } catch { /* best effort */ }
  }

  function pickBest({ exclude = [] } = {}) {
    try { return best(accountsOf(registry()), clock(), exclude); } catch { return null; }
  }

  // A limit hit -> which account hit it, and the account to continue on (switching the live login when needed).
  // Never throws; a failed swap returns next null with error, and the caller falls back to Codex.
  async function handleLimit(info) {
    const { runAccount = null, at = null, resetsAt = null, source = 'limit' } = info ?? {};
    let hit = null;
    let duplicate = false;
    try {
      const reg = registry();
      const names = Object.keys(reg.accounts);
      if (!names.length) return { next: null };
      const active = activeOf(reg);
      const atMs = toMs(at) ?? clock();
      const secs = toSecs(resetsAt);
      hit = runAccount ?? owner(reg, active, secs);
      if (!runAccount) {
        const since = reg.lastSwitch ? atMs - (toMs(reg.lastSwitch.at) ?? 0) : Infinity;
        const recent = reg.lastSwitch && since >= 0 && since < DUPLICATE_MS;
        if (hit !== active) duplicate = true;
        else if (recent) { // a chat hit is not tied to a run: at most one switch per window, whatever reset time it claims
          duplicate = true;
          hit = secs == null ? reg.lastSwitch.from ?? null : null;
        }
      }
      if (hit) recordLimit(hit, { at: atMs, resetsAt: secs });
      const now = clock();
      const accounts = accountsOf(registry());
      const avail = (n) => isAvailable(accounts.find((a) => a.name === n), now);
      const next = duplicate && active && avail(active) ? active : best(accounts, now, hit ? [hit] : []);
      if (!next) return { hitAccount: hit, next: null, switched: false, duplicate };
      if (next === active) return { hitAccount: hit, next, switched: false, duplicate };
      const r = await use(next, { reason: `${source} limit${hit ? ` on ${hit}` : ''}`, waitMs: limitWaitMs });
      return { hitAccount: hit, next, switched: r.switched, duplicate };
    } catch (e) {
      return { hitAccount: hit, next: null, switched: false, duplicate, error: e.message };
    }
  }

  // Refreshes a non-active account's saved login through Claude Code, holding the lock so no swap reads a stale token.
  async function refresh(name) {
    return withLock(dataDir, async () => {
      const reg = registry();
      need(reg, name);
      if (activeOf(reg) === name) throw new Error(`"${name}" is the live login; Claude Code refreshes it itself`);
      const login = parseOauth(await vault.get(key(name)));
      if (!login) throw new Error(`no saved login for "${name}"`);
      const { oauth } = await refreshLogin(login, { claude, spawn, env, onRateLimit: (info) => recordRateLimit(name, info) });
      await vault.set(key(name), JSON.stringify(oauth));
      const fresh = registry();
      markSaved(fresh, name, oauth);
      saveRegistry(dataDir, fresh);
      return { name, refreshExpiresAt: fresh.accounts[name]?.refreshExpiresAt ?? null };
    });
  }

  // Refreshes the non-active accounts whose refresh token expires within 7 days. -> [{name, ok, error?}]
  async function refreshDue() {
    const out = [];
    let reg;
    try { reg = registry(); } catch (e) { return [{ name: null, ok: false, error: e.message }]; }
    const active = activeName();
    const now = clock();
    for (const [name, a] of Object.entries(reg.accounts).sort(([x], [y]) => (x < y ? -1 : 1))) {
      const exp = toMs(a.refreshExpiresAt);
      if (name === active || exp == null || exp - now > REFRESH_AHEAD_MS) continue;
      try { await refresh(name); out.push({ name, ok: true }); } catch (e) { out.push({ name, ok: false, error: e.message }); }
    }
    return out;
  }

  // Saves the live login to its account's vault entry when it changed (live processes rotate refresh tokens).
  // -> true saved, false nothing to save, null failed (retried on the next check).
  let syncing = null;
  // Checked once without the lock (cheap), then again under it: a swap in between may have changed the file.
  const pending = () => {
    const reg = registry();
    const oauth = identity(reg).oauth;
    if (!oauth) return null;
    const name = nameFor(reg, oauth.accountUuid);
    return name && saved.get(name) !== hash(oauth) ? { reg, name, oauth } : null;
  };
  async function doSync() {
    try {
      if (!pending()) return false;
      return await withLock(dataDir, async () => {
        const p = pending();
        if (!p) return false;
        await vault.set(key(p.name), JSON.stringify(p.oauth));
        markSaved(p.reg, p.name, p.oauth);
        saveRegistry(dataDir, p.reg);
        return true;
      }, { waitMs: 5000 });
    } catch { return null; }
  }
  const syncBack = () => { if (!syncing) syncing = doSync().finally(() => { syncing = null; }); return syncing; };

  // Watches the live file (fs.watch + an mtime poll) for sync-back and runs refreshDue every 6 h.
  function startSync({ intervalMs = 15_000, refreshMs = REFRESH_EVERY_MS } = {}) {
    close();
    const file = credsPath(home);
    let last = null;
    const stamp = () => { try { const s = fs.statSync(file); return `${s.mtimeMs}:${s.size}`; } catch { return null; } };
    const check = () => {
      const s = stamp();
      if (s === last) return;
      last = s;
      syncBack().then((r) => { if (r === null && last === s) last = null; });
    };
    try {
      watcher = fs.watch(home, { persistent: false }, (_ev, f) => {
        if (f && String(f) !== '.credentials.json') return;
        clearTimeout(debounce);
        debounce = setTimeout(check, 300);
      });
      watcher.on('error', () => {});
    } catch { watcher = null; }
    const poll = setInterval(check, intervalMs);
    const first = setTimeout(() => { refreshDue().catch(() => {}); }, Math.min(60_000, refreshMs));
    const every = setInterval(() => { refreshDue().catch(() => {}); }, refreshMs);
    timers = [poll, first, every];
    for (const t of timers) t.unref?.();
    check();
  }

  function close() {
    for (const t of timers) clearInterval(t); // clears timeouts too
    clearTimeout(debounce);
    timers = [];
    try { watcher?.close(); } catch { /* closed */ }
    watcher = null;
  }

  return {
    list, liveReason, activeName, hasAccounts, add, use, remove, recordReading, recordRateLimit, recordLimit, pickBest, handleLimit,
    refresh, refreshDue, syncBack, startSync, close,
  };
}
