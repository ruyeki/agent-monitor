// SQLite store plus the run operations that tie the engine to the database.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { seedWorkflow, normalizeWorkflow, validateWorkflow } from './workflow.js';
import * as engine from './engine.js';

// node:sqlite is still flagged experimental. Keep that one warning out of the server log.
const emitWarning = process.emitWarning;
process.emitWarning = (w, ...rest) => {
  if (/SQLite/.test(typeof w === 'string' ? w : w?.message)) return;
  return emitWarning.call(process, w, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');
process.emitWarning = emitWarning;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workflow_versions (version INTEGER PRIMARY KEY, json TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workflow_draft (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL, base_version INTEGER);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, task TEXT, repo TEXT, branch TEXT, workflow_version INTEGER NOT NULL,
  stage TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, verdict TEXT, ask TEXT, note TEXT,
  answer_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  stage TEXT, round INTEGER, verdict TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id, id);
CREATE TABLE IF NOT EXISTS activity (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, agent_id TEXT, at TEXT NOT NULL,
  event TEXT NOT NULL, tool TEXT, summary TEXT);
CREATE INDEX IF NOT EXISTS activity_run ON activity (run_id, id);
CREATE TABLE IF NOT EXISTS session_links (
  session_id TEXT NOT NULL, run_id TEXT NOT NULL, last_active_at TEXT NOT NULL, PRIMARY KEY (session_id, run_id));
CREATE TABLE IF NOT EXISTS agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, type TEXT, model TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'running', last_tool TEXT, last_summary TEXT, last_activity_at TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  waiting_permission INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  transcript_path TEXT, transcript_offset INTEGER NOT NULL DEFAULT 0, last_msg_id TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, last_message TEXT);
CREATE INDEX IF NOT EXISTS agents_run ON agents (run_id);
`;

const AGENT_COLUMNS = new Set([
  'run_id', 'type', 'model', 'description', 'status', 'last_tool', 'last_summary', 'last_activity_at', 'tool_calls',
  'errors', 'last_error', 'waiting_permission', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
  'cache_read_tokens', 'transcript_path', 'transcript_offset', 'last_msg_id', 'finished_at', 'last_message',
]);
const ACTIVITY_CAP = 500;
const now = () => new Date().toISOString();
const parse = (json) => JSON.parse(json);

export function slugify(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
}

const toAgent = (a) => ({
  id: a.agent_id, type: a.type, model: a.model, description: a.description, status: a.status,
  lastTool: a.last_tool, lastSummary: a.last_summary, lastActivityAt: a.last_activity_at,
  toolCalls: a.tool_calls, errors: a.errors, lastError: a.last_error, waitingPermission: !!a.waiting_permission,
  tokens: { input: a.input_tokens, output: a.output_tokens, cacheCreation: a.cache_creation_tokens, cacheRead: a.cache_read_tokens },
  startedAt: a.started_at, finishedAt: a.finished_at,
});

const MAX_STAGES = 100;
const MAX_ACTIONS = 10;
const MAX_LEN = { id: 80, name: 80, ask: 1000, instructions: 4000 };
const MAX_LABEL = 80;

// Size limits only (validateWorkflow judges content); keeps a saved draft cheap to validate.
function oversize(wf) {
  if (wf.stages.length > MAX_STAGES) return `A workflow can have at most ${MAX_STAGES} stages.`;
  for (const s of wf.stages) {
    if (!s || typeof s !== 'object') continue;
    const actions = Array.isArray(s.actions) ? s.actions : [];
    if (actions.length > MAX_ACTIONS) return `A gate can have at most ${MAX_ACTIONS} actions.`;
    for (const [field, max] of Object.entries(MAX_LEN)) {
      if (typeof s[field] === 'string' && s[field].length > max) return `Stage ${field} is longer than ${max} characters.`;
    }
    if (actions.some((a) => typeof a?.label === 'string' && a.label.length > MAX_LABEL)) return `Action label is longer than ${MAX_LABEL} characters.`;
  }
  return null;
}

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'agent-monitor.db'));
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
  db.exec(SCHEMA);
  const bus = new EventEmitter();
  bus.setMaxListeners(0);
  const emit = (type, runId) => bus.emit('change', { type, runId });
  const q = (sql) => db.prepare(sql);
  const versionCache = new Map();

  if (!q('SELECT 1 FROM workflow_versions').get()) {
    const json = JSON.stringify(seedWorkflow());
    q('INSERT INTO workflow_versions (version, json, published_at) VALUES (1, ?, ?)').run(json, now());
    q('INSERT INTO workflow_draft (id, json, updated_at, base_version) VALUES (1, ?, ?, 1)').run(json, now());
  }

  // ---- workflow versions and draft ----
  const latestVersion = () => q('SELECT MAX(version) AS v FROM workflow_versions').get().v;
  function version(v) {
    if (!versionCache.has(v)) {
      const row = q('SELECT json FROM workflow_versions WHERE version = ?').get(v);
      if (!row) return null;
      versionCache.set(v, normalizeWorkflow(parse(row.json)));
    }
    return versionCache.get(v);
  }
  const published = () => {
    const v = latestVersion();
    return { version: v, workflow: version(v), publishedAt: q('SELECT published_at FROM workflow_versions WHERE version = ?').get(v).published_at };
  };
  const draft = () => {
    const row = q('SELECT * FROM workflow_draft WHERE id = 1').get();
    const workflow = normalizeWorkflow(parse(row.json));
    return { workflow, updatedAt: row.updated_at, baseVersion: row.base_version, errors: validateWorkflow(workflow) };
  };
  function setDraft(workflow, baseVersion) {
    q('UPDATE workflow_draft SET json = ?, updated_at = ?, base_version = ? WHERE id = 1').run(JSON.stringify(workflow), now(), baseVersion);
    emit('workflow');
    return draft();
  }
  function saveDraft(wf) {
    if (!wf || typeof wf !== 'object' || !Array.isArray(wf.stages)) return { error: 'workflow must be an object with a stages list.' };
    const tooLong = oversize(wf);
    if (tooLong) return { error: tooLong };
    return { draft: setDraft(normalizeWorkflow(wf), draft().baseVersion) };
  }
  const resetDraft = () => setDraft(published().workflow, latestVersion());
  function loadVersion(v) {
    const wf = version(v);
    return wf ? setDraft(wf, v) : null;
  }
  function publish() {
    const wf = draft().workflow;
    const errors = validateWorkflow(wf);
    if (errors.length) return { errors };
    const v = latestVersion() + 1;
    q('INSERT INTO workflow_versions (version, json, published_at) VALUES (?, ?, ?)').run(v, JSON.stringify(wf), now());
    q('UPDATE workflow_draft SET base_version = ? WHERE id = 1').run(v);
    emit('workflow');
    return { version: v };
  }
  const versions = () => q('SELECT version, json, published_at FROM workflow_versions ORDER BY version DESC').all()
    .map((r) => ({ version: r.version, publishedAt: r.published_at, stages: parse(r.json).stages.length }));

  // ---- runs ----
  const getRun = (id) => q('SELECT * FROM runs WHERE id = ?').get(String(id)) ?? null;
  const stateOf = (r) => ({ stage: r.stage, round: r.round, status: r.status, verdict: r.verdict, ask: r.ask });

  function summary(r) {
    const wf = version(r.workflow_version);
    const desc = engine.describeStage(wf, r.stage, stateOf(r));
    const waiting = r.status === 'waiting';
    return {
      id: r.id, title: r.title, task: r.task, repo: r.repo, branch: r.branch, workflowVersion: r.workflow_version,
      stage: r.stage, stageName: desc?.name ?? r.stage, round: r.round, maxRounds: wf.loop.maxRounds, status: r.status,
      verdict: r.verdict, ask: r.ask, actions: waiting ? (desc?.actions ?? []).map((a) => ({ label: a.label })) : [],
      textField: waiting && !!desc?.textField, note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at,
    };
  }

  function addEvent(runId, kind, { stage = null, round = null, verdict = null, note = null } = {}) {
    q('INSERT INTO run_events (run_id, at, kind, stage, round, verdict, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, now(), kind, stage, round, verdict, note);
  }

  function save(r, state, extra = {}) {
    const ended = state.status === 'done' || state.status === 'stopped';
    q(`UPDATE runs SET stage = ?, round = ?, status = ?, verdict = ?, ask = ?, note = ?, answer_json = ?, updated_at = ?,
       ended_at = ? WHERE id = ?`).run(state.stage, state.round, state.status, state.verdict ?? null, state.ask ?? null,
      extra.note ?? r.note, extra.answer ? JSON.stringify(extra.answer) : r.answer_json, now(), ended ? (r.ended_at ?? now()) : null, r.id);
    emit('run', r.id);
    return summary(getRun(r.id));
  }

  function startRun({ title, slug, task, repo, branch, note }) {
    if (!String(title ?? '').trim()) return { error: 'title is required.' };
    const base = slugify(slug) || slugify(title) || 'run';
    let id = base;
    for (let n = 2; getRun(id); n++) id = `${base}-${n}`;
    const wf = published();
    const state = engine.startState(wf.workflow);
    q(`INSERT INTO runs (id, title, task, repo, branch, workflow_version, stage, round, status, verdict, ask, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(id, String(title).trim(), task ?? null, repo ?? null, branch ?? null,
      wf.version, state.stage, state.round, state.status, state.ask, note ?? null, now(), now());
    addEvent(id, 'stage', { stage: state.stage, round: 0, note: note || 'Run started' });
    emit('run', id);
    return { run: summary(getRun(id)) };
  }

  const listRuns = () => q('SELECT * FROM runs ORDER BY updated_at DESC, rowid DESC').all().map(summary);

  function mutate(id, fn) {
    const r = getRun(id);
    if (!r) return { error: `No run '${id}'.`, notFound: true };
    return fn(r, version(r.workflow_version));
  }

  const completeStage = (id, { stage, outcome, note }) => mutate(id, (r, wf) => {
    const res = engine.completeStage(wf, stateOf(r), { stage, outcome, note });
    if (!res.ok) return { error: res.error };
    addEvent(id, 'stage', { stage, round: r.round, verdict: outcome, note });
    return { run: save(r, res.state, { note: note || r.note }) };
  });

  const respond = (id, { action, text }) => mutate(id, (r, wf) => {
    const res = engine.respond(wf, stateOf(r), { action, text });
    if (!res.ok) return { error: res.error };
    addEvent(id, 'answer', { stage: r.stage, round: r.round, note: res.answer.text ? `${res.answer.action}: ${res.answer.text}` : res.answer.action });
    return { run: save(r, res.state, { answer: { ...res.answer, stage: r.stage } }) };
  });

  const stopRun = (id) => mutate(id, (r) => {
    if (r.status === 'done' || r.status === 'stopped') return { error: `Run is already ${r.status}.` };
    addEvent(id, 'stop', { stage: r.stage, round: r.round, note: 'Stopped' });
    return { run: save(r, engine.stop(stateOf(r)), { answer: { action: 'Stop run', text: '', stage: r.stage } }) };
  });

  const logRun = (id, note) => mutate(id, (r) => {
    addEvent(id, 'log', { stage: r.stage, round: r.round, note });
    return { run: save(r, stateOf(r), { note }) };
  });

  function detail(id) {
    const r = getRun(id);
    if (!r) return null;
    return {
      run: summary(r), workflow: version(r.workflow_version),
      timeline: q('SELECT at, kind, stage, round, verdict, note FROM run_events WHERE run_id = ? ORDER BY id').all(id),
      agents: q('SELECT * FROM agents WHERE run_id = ? ORDER BY started_at, rowid').all(id).map(toAgent),
      activity: q('SELECT at, agent_id AS agentId, event, tool, summary FROM activity WHERE run_id = ? ORDER BY id DESC LIMIT 100').all(id),
    };
  }

  // ---- hook support: session links, agents, activity ----
  const linkSession = (sessionId, runId) => q(`INSERT INTO session_links (session_id, run_id, last_active_at) VALUES (?, ?, ?)
    ON CONFLICT (session_id, run_id) DO UPDATE SET last_active_at = excluded.last_active_at`).run(sessionId, runId, now());
  const touchSession = (sessionId, runId) => q('UPDATE session_links SET last_active_at = ? WHERE session_id = ? AND run_id = ?').run(now(), sessionId, runId);
  // The session's most recently active run. Main-session events want a live run; a new subagent also adopts a stopped one (so it is denied).
  const sessionRun = (sessionId, { adoptStopped = false } = {}) => q(`SELECT r.* FROM session_links l JOIN runs r ON r.id = l.run_id
    WHERE l.session_id = ? AND r.status NOT IN (${adoptStopped ? "'done'" : "'done', 'stopped'"}) ORDER BY l.last_active_at DESC, l.rowid DESC LIMIT 1`).get(sessionId) ?? null;
  const getAgent = (id) => q('SELECT * FROM agents WHERE agent_id = ?').get(id) ?? null;
  const createAgent = (a) => {
    q(`INSERT OR IGNORE INTO agents (agent_id, run_id, session_id, type, transcript_path, transcript_offset, started_at, last_activity_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(a.id, a.runId, a.sessionId ?? null, a.type ?? null, a.transcriptPath ?? null, a.offset ?? 0, now(), now());
    emit('agent', a.runId);
  };
  function updateAgent(id, fields) {
    const keys = Object.keys(fields).filter((k) => AGENT_COLUMNS.has(k));
    if (!keys.length) return;
    q(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE agent_id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    emit('agent', getAgent(id)?.run_id);
  }
  function addActivity(runId, agentId, event, tool, text) {
    q('INSERT INTO activity (run_id, agent_id, at, event, tool, summary) VALUES (?, ?, ?, ?, ?, ?)').run(runId, agentId, now(), event, tool ?? null, text ?? null);
    q(`DELETE FROM activity WHERE run_id = ? AND id <= (SELECT id FROM activity WHERE run_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(runId, runId, ACTIVITY_CAP);
    emit('activity', runId);
  }
  const activityCount = (runId) => q('SELECT COUNT(*) AS n FROM activity WHERE run_id = ?').get(runId).n;
  const close = () => db.close();

  return {
    bus, close, version, published, draft, saveDraft, resetDraft, loadVersion, publish, versions,
    getRun, summary, listRuns, startRun, completeStage, respond, stopRun, logRun, detail,
    linkSession, touchSession, sessionRun, getAgent, createAgent, updateAgent, addActivity, activityCount,
  };
}
