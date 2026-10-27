// Standalone usage indexer: reads Claude Code transcripts (read-only) into usage.db.
// Stores numbers, ids, model and timestamps only, never message content.
import fs from 'node:fs';
import path from 'node:path';
import { SEED_PRICES, validatePrices } from './prices.js';

// node:sqlite is still flagged experimental. Keep that one warning out of the server log.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (/SQLite/.test(typeof w === 'string' ? w : w?.message)) return;
  return emitWarning.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usage_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, offset INTEGER NOT NULL, mtime_ms REAL NOT NULL);
CREATE TABLE IF NOT EXISTS usage_messages (
  id TEXT PRIMARY KEY, ts TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT, agent_id TEXT, project TEXT, model TEXT,
  input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
  cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS usage_messages_day ON usage_messages (day);
CREATE INDEX IF NOT EXISTS usage_messages_agent ON usage_messages (agent_id);
CREATE INDEX IF NOT EXISTS usage_messages_session ON usage_messages (session_id);
CREATE TABLE IF NOT EXISTS prices (
  model TEXT PRIMARY KEY, input REAL NOT NULL, output REAL NOT NULL, cache_write REAL NOT NULL,
  cache_write_1h REAL NOT NULL, cache_read REAL NOT NULL, note TEXT NOT NULL DEFAULT '');
`;

const CHUNK = 512 * 1024;
const MARKER = Buffer.from('"usage"');
const NL = 0x0a;
const pad = (n) => String(n).padStart(2, '0');
const localDay = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
const yieldLoop = () => new Promise((r) => setImmediate(r));

// Parses one transcript line into a message row, or null when it is not a usable assistant message.
function parseLine(buf, file) {
  let o;
  try { o = JSON.parse(buf.toString('utf8')); } catch { return null; }
  const m = o?.message;
  const u = m?.usage;
  if (!m || !u || typeof m.id !== 'string' || !m.id || m.model === '<synthetic>' || typeof o.timestamp !== 'string') return null;
  const d = new Date(o.timestamp);
  if (Number.isNaN(d.getTime())) return null;
  const cw = num(u.cache_creation_input_tokens);
  const cw1h = Math.min(cw, num(u.cache_creation?.ephemeral_1h_input_tokens));
  return {
    id: m.id, ts: d.toISOString(), day: localDay(d), session: typeof o.sessionId === 'string' ? o.sessionId : file.session,
    agent: typeof o.agentId === 'string' ? o.agentId : null, project: file.project, model: typeof m.model === 'string' ? m.model : null,
    input: num(u.input_tokens), output: num(u.output_tokens), cw, cw1h, cr: num(u.cache_read_input_tokens),
  };
}

export async function openUsage({ dataDir, projectsDir }) {
  fs.mkdirSync(dataDir, { recursive: true });
  const root = path.resolve(projectsDir);
  const db = new DatabaseSync(path.join(dataDir, 'usage.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  if (db.prepare('PRAGMA user_version').get().user_version < 1) {
    const ins = db.prepare('INSERT OR IGNORE INTO prices (model, input, output, cache_write, cache_write_1h, cache_read, note) VALUES (?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    for (const p of SEED_PRICES) ins.run(p.model, p.input, p.output, p.cacheWrite, p.cacheWrite1h, p.cacheRead, p.note);
    db.exec('PRAGMA user_version = 1; COMMIT');
  }

  const getFile = db.prepare('SELECT size, offset FROM usage_files WHERE path = ?');
  const putFile = db.prepare(`INSERT INTO usage_files (path, size, offset, mtime_ms) VALUES (?,?,?,?)
    ON CONFLICT(path) DO UPDATE SET size = excluded.size, offset = excluded.offset, mtime_ms = excluded.mtime_ms`);
  const upsert = db.prepare(`INSERT INTO usage_messages (id, ts, day, session_id, agent_id, project, model, input, output, cache_write, cache_write_1h, cache_read)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET input = MAX(input, excluded.input), output = MAX(output, excluded.output),
      cache_write = MAX(cache_write, excluded.cache_write), cache_write_1h = MAX(cache_write_1h, excluded.cache_write_1h),
      cache_read = MAX(cache_read, excluded.cache_read)`);
  const countMessages = db.prepare('SELECT COUNT(*) AS n FROM usage_messages');
  const countFiles = db.prepare('SELECT COUNT(*) AS n FROM usage_files');

  const state = { generation: 0, scanning: null, lastScanAt: null, lastScanMs: null, backfillMs: null, timer: null, closed: false };
  const firstScanIsBackfill = countFiles.get().n === 0;

  // Recursive walk for regular *.jsonl files inside root. Symlinks are never followed.
  async function walk(dir, out) {
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) await walk(p, out);
      else if (e.isFile() && e.name.endsWith('.jsonl') && p.startsWith(root + path.sep)) out.push(p);
    }
  }

  async function indexFile(file) {
    let st;
    try { st = await fs.promises.lstat(file); } catch { return; }
    if (!st.isFile()) return;
    const rel = path.relative(root, file).split(path.sep);
    const info = { project: rel[0], session: rel.length > 2 ? rel[1] : path.basename(file, '.jsonl') };
    const known = getFile.get(file);
    let consumed = known && known.offset <= st.size ? known.offset : 0;
    if (known && known.offset === st.size && known.size === st.size) return;
    let fh;
    try { fh = await fs.promises.open(file, 'r'); } catch { return; }
    try {
      let parts = []; // the unfinished line, kept as chunks until its newline arrives
      let carryLen = 0;
      const chunk = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await fh.read(chunk, 0, CHUNK, consumed + carryLen);
        if (bytesRead === 0) break;
        const fresh = chunk.subarray(0, bytesRead);
        if (fresh.indexOf(NL) < 0) {
          parts.push(Buffer.from(fresh));
          carryLen += bytesRead;
          await yieldLoop();
          if (state.closed) return;
          continue;
        }
        const data = parts.length ? Buffer.concat([...parts, fresh]) : Buffer.from(fresh);
        const end = data.lastIndexOf(NL) + 1;
        db.exec('BEGIN');
        let wrote = false;
        try {
          for (let s = 0; s < end;) {
            const nl = data.indexOf(NL, s);
            const line = data.subarray(s, nl);
            s = nl + 1;
            if (line.indexOf(MARKER) < 0) continue;
            const r = parseLine(line, info);
            if (r) { upsert.run(r.id, r.ts, r.day, r.session, r.agent, r.project, r.model, r.input, r.output, r.cw, r.cw1h, r.cr); wrote = true; }
          }
          consumed += end;
          putFile.run(file, st.size, consumed, st.mtimeMs);
          db.exec('COMMIT');
          if (wrote) state.generation++;
        } catch (e) { db.exec('ROLLBACK'); throw e; }
        const rest = data.subarray(end);
        parts = rest.length ? [rest] : [];
        carryLen = rest.length;
        await yieldLoop();
        if (state.closed) return;
      }
      if (!known || known.size !== st.size) putFile.run(file, st.size, consumed, st.mtimeMs);
    } finally { await fh.close(); }
  }

  async function doScan() {
    const t0 = Date.now();
    const before = countMessages.get().n;
    const files = [];
    await walk(root, files);
    for (const f of files) {
      if (state.closed) break;
      try { await indexFile(f); } catch { /* one unreadable file must not stop the scan */ }
    }
    const ms = Date.now() - t0;
    state.lastScanAt = new Date().toISOString();
    state.lastScanMs = ms;
    if (firstScanIsBackfill && state.backfillMs == null) state.backfillMs = ms;
    return { files: files.length, newMessages: countMessages.get().n - before, ms };
  }

  // Scans never overlap: a call during a scan gets the running scan's result.
  function scan() {
    if (!state.scanning) state.scanning = doScan().finally(() => { state.scanning = null; });
    return state.scanning;
  }

  const toMessage = (r) => ({ id: r.id, ts: r.ts, day: r.day, sessionId: r.session_id, agentId: r.agent_id, model: r.model,
    input: r.input, output: r.output, cacheWrite: r.cache_write, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read });
  const isDay = (s) => typeof s === 'string' && /^\d{4}-\d\d-\d\d$/.test(s);

  // from/to: 'YYYY-MM-DD' filters by local day (inclusive), anything else is an ISO timestamp bound on ts.
  // agentNull keeps main-session rows (agent_id IS NULL).
  function filter({ agentIds, sessionIds, agentNull, from, to }) {
    const where = [];
    const args = [];
    const list = (col, v) => { if (Array.isArray(v)) { where.push(v.length ? `${col} IN (${v.map(() => '?').join(',')})` : '0'); args.push(...v); } };
    list('agent_id', agentIds);
    list('session_id', sessionIds);
    if (agentNull) where.push('agent_id IS NULL');
    if (from) { where.push(isDay(from) ? 'day >= ?' : 'ts >= ?'); args.push(from); }
    if (to) { where.push(isDay(to) ? 'day <= ?' : 'ts <= ?'); args.push(to); }
    return { sql: where.length ? ` WHERE ${where.join(' AND ')}` : '', args };
  }

  function messages(q = {}) {
    const { sql, args } = filter(q);
    return db.prepare(`SELECT * FROM usage_messages${sql} ORDER BY ts, id`).all(...args).map(toMessage);
  }

  // Token sums per (agent, session, model), so attribution never loads individual messages for non-lead agents.
  function totals(q = {}) {
    const { sql, args } = filter(q);
    return db.prepare(`SELECT agent_id, session_id, model, SUM(input) AS input, SUM(output) AS output, SUM(cache_write) AS cache_write,
      SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read) AS cache_read FROM usage_messages${sql} GROUP BY agent_id, session_id, model`).all(...args)
      .map((r) => ({ agentId: r.agent_id, sessionId: r.session_id, model: r.model, input: r.input, output: r.output,
        cacheWrite: r.cache_write, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read }));
  }

  function daily({ from, to } = {}) {
    const where = [];
    const args = [];
    if (from) { where.push('day >= ?'); args.push(from); }
    if (to) { where.push('day <= ?'); args.push(to); }
    return db.prepare(`SELECT day, model, SUM(input) AS input, SUM(output) AS output, SUM(cache_write) AS cache_write,
      SUM(cache_write_1h) AS cache_write_1h, SUM(cache_read) AS cache_read, COUNT(*) AS messages FROM usage_messages
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} GROUP BY day, model ORDER BY day, model`).all(...args)
      .map((r) => ({ day: r.day, model: r.model, input: r.input, output: r.output, cacheWrite: r.cache_write,
        cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read, messages: r.messages }));
  }

  const prices = () => db.prepare('SELECT * FROM prices ORDER BY model').all().map((r) => ({ model: r.model, input: r.input,
    output: r.output, cacheWrite: r.cache_write, cacheWrite1h: r.cache_write_1h, cacheRead: r.cache_read, note: r.note }));

  // Replaces the whole table. Returns the saved rows, or {error}.
  function setPrices(rows) {
    const v = validatePrices(rows);
    if (v.error) return v;
    const ins = db.prepare('INSERT INTO prices (model, input, output, cache_write, cache_write_1h, cache_read, note) VALUES (?,?,?,?,?,?,?)');
    db.exec('BEGIN');
    try {
      db.exec('DELETE FROM prices');
      for (const p of v.rows) ins.run(p.model, p.input, p.output, p.cacheWrite, p.cacheWrite1h, p.cacheRead, p.note);
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return prices();
  }

  function start({ intervalMs = 5000, onScan } = {}) {
    if (state.timer || state.closed) return;
    const run = () => scan().then((r) => { if (!state.closed) onScan?.(r); }).catch(() => {});
    state.timer = setInterval(run, intervalMs);
    state.timer.unref?.();
    run();
  }

  function stop() {
    if (state.timer) clearInterval(state.timer);
    state.timer = null;
  }

  async function close() {
    stop();
    state.closed = true;
    if (state.scanning) await state.scanning.catch(() => {});
    db.close();
  }

  const status = () => ({ files: countFiles.get().n, messages: countMessages.get().n, scanning: !!state.scanning,
    lastScanAt: state.lastScanAt, lastScanMs: state.lastScanMs, backfillMs: state.backfillMs, generation: state.generation });

  return { scan, start, stop, close, status, messages, totals, daily, prices, setPrices };
}
