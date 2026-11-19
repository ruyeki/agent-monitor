// Accounts state on disk (<dataDir>/accounts): registry.json and usage-<name>.json, never secrets.
// Atomic JSON writes (temp file in the same folder + rename) and a lock file around swaps and registry writes.
// Times are ISO strings; window resets_at and limit resetsAt are epoch seconds.
import fs from 'node:fs';
import path from 'node:path';
import { guardReal } from './paths.js';

export const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const LOCK_STALE_MS = 60_000;
const LOCK_WAIT_MS = 10_000; // short for the CLI; limit hand-offs pass a longer wait
const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']);

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export const accountsDir = (dataDir) => path.join(guardReal(dataDir), 'accounts');
const registryFile = (dataDir) => path.join(accountsDir(dataDir), 'registry.json');
const usageFile = (dataDir, name) => path.join(accountsDir(dataDir), `usage-${name}.json`);

// Writes text to file atomically. Windows can refuse a rename while a reader has the file open: retried 5 times.
export function writeAtomic(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  for (let i = 0; ; i++) {
    try { fs.renameSync(tmp, file); return; } catch (e) {
      if (i >= 5 || !RETRY.has(e.code)) { try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
      sleepSync(40 * (i + 1));
    }
  }
}

const readJson = (file) => {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return undefined; throw e; }
};

// A missing registry is empty; a corrupt one throws (nothing may overwrite it blindly).
export function loadRegistry(dataDir) {
  const r = readJson(registryFile(dataDir));
  if (r === undefined) return { accounts: {}, lastSwitch: null };
  if (!r || typeof r !== 'object' || !r.accounts || typeof r.accounts !== 'object') throw new Error('accounts registry is corrupt');
  return { accounts: r.accounts, lastSwitch: r.lastSwitch ?? null };
}

export const saveRegistry = (dataDir, reg) => writeAtomic(registryFile(dataDir), `${JSON.stringify(reg, null, 2)}\n`);

// A missing or unreadable usage file reads as no data.
export function readUsage(dataDir, name) {
  let u;
  try { u = readJson(usageFile(dataDir, name)); } catch { u = undefined; }
  return { reading: u?.reading ?? null, limit: u?.limit ?? null };
}

export const writeUsage = (dataDir, name, u) => writeAtomic(usageFile(dataDir, name), `${JSON.stringify(u)}\n`);
export const removeUsage = (dataDir, name) => fs.rmSync(usageFile(dataDir, name), { force: true });

const sameWindow = (a, b) => (a?.used_percentage ?? null) === (b?.used_percentage ?? null) && (a?.resets_at ?? null) === (b?.resets_at ?? null);

// Merges a reading into name's usage file (an absent window keeps the stored one). Writes only when a window changed.
export function saveReading(dataDir, name, { five_hour = null, seven_day = null }, now) {
  const u = readUsage(dataDir, name);
  const old = u.reading ?? {};
  const next = { five_hour: five_hour ?? old.five_hour ?? null, seven_day: seven_day ?? old.seven_day ?? null };
  if (u.reading && sameWindow(old.five_hour, next.five_hour) && sameWindow(old.seven_day, next.seven_day)) return false;
  writeUsage(dataDir, name, { ...u, reading: { ...next, at: new Date(now).toISOString() } });
  return true;
}

// Runs fn holding <dataDir>/accounts/.lock. The lock's mtime is kept fresh while fn runs; one older than 60 s is stale.
export async function withLock(dataDir, fn, { waitMs = LOCK_WAIT_MS } = {}) {
  const dir = accountsDir(dataDir);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '.lock');
  const end = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = fs.openSync(file, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let seen;
      try { seen = fs.statSync(file); } catch { continue; }
      if (Date.now() - seen.mtimeMs > LOCK_STALE_MS) {
        // Re-stat right before removing: a rival may already have replaced the stale lock with a fresh one, which must stay.
        let now;
        try { now = fs.statSync(file); } catch { continue; }
        if (now.mtimeMs === seen.mtimeMs && now.ino === seen.ino) fs.rmSync(file, { force: true });
        continue;
      }
      if (Date.now() > end) throw new Error('accounts are busy (another switch or refresh is running)');
      await sleep(100);
    }
  }
  const beat = setInterval(() => { try { const t = new Date(); fs.utimesSync(file, t, t); } catch { /* gone */ } }, 15_000);
  beat.unref();
  try { return await fn(); } finally { clearInterval(beat); fs.rmSync(file, { force: true }); }
}
