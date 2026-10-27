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
  answer_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT, active_json TEXT, joins_json TEXT);
CREATE TABLE IF NOT EXISTS run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  stage TEXT, round INTEGER, verdict TEXT, note TEXT);
CREATE INDEX IF NOT EXISTS run_events_run ON run_events (run_id, id);
CREATE TABLE IF NOT EXISTS node_visits (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, node_id TEXT NOT NULL, entered_at TEXT NOT NULL,
  left_at TEXT, outcome TEXT);
CREATE INDEX IF NOT EXISTS node_visits_run ON node_visits (run_id, id);
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
  started_at TEXT NOT NULL, finished_at TEXT, last_message TEXT, start_nodes TEXT, reported_nodes TEXT);
CREATE INDEX IF NOT EXISTS agents_run ON agents (run_id);
`;
// Columns added after v1: an older database gets them in the migration.
const NEW_COLUMNS = { runs: ['active_json', 'joins_json'], agents: ['start_nodes', 'reported_nodes'] };
const SCHEMA_VERSION = 2;

const AGENT_COLUMNS = new Set([
  'run_id', 'type', 'model', 'description', 'status', 'last_tool', 'last_summary', 'last_activity_at', 'tool_calls',
  'errors', 'last_error', 'waiting_permission', 'input_tokens', 'output_tokens', 'cache_creation_tokens',
  'cache_read_tokens', 'transcript_path', 'transcript_offset', 'last_msg_id', 'finished_at', 'last_message',
]);
const ACTIVITY_CAP = 500;
const MAX_REPORTED = 100;
const ENDED = ['done', 'stopped'];
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

const LIMITS = { nodes: 100, edges: 300, actions: 10, label: 80, edgeId: 120 };
const NODE_LEN = { id: 80, name: 80, ask: 1000, instructions: 4000 };
const EDGE_LEN = { from: 80, to: 80, on: 80 };

// Size limits only (validateWorkflow judges content); keeps a saved draft cheap to validate.
function oversize(wf) {
  const edges = Array.isArray(wf.edges) ? wf.edges : [];
  if (wf.nodes.length > LIMITS.nodes) return `A workflow can have at most ${LIMITS.nodes} nodes.`;
  if (edges.length > LIMITS.edges) return `A workflow can have at most ${LIMITS.edges} edges.`;
  const tooLong = (o, limits) => Object.entries(limits).find(([f, max]) => typeof o[f] === 'string' && o[f].length > max);
  for (const n of wf.nodes) {
    if (!n || typeof n !== 'object') continue;
    const actions = Array.isArray(n.actions) ? n.actions : [];
    if (actions.length > LIMITS.actions) return `A gate can have at most ${LIMITS.actions} actions.`;
    const long = tooLong(n, NODE_LEN);
    if (long) return `Node ${long[0]} is longer than ${long[1]} characters.`;
    if (actions.some((a) => typeof a?.label === 'string' && a.label.length > LIMITS.label)) return `Action label is longer than ${LIMITS.label} characters.`;
  }
  for (const e of edges) {
    if (!e || typeof e !== 'object') continue;
    if (typeof e.id === 'string' && e.id.length > LIMITS.edgeId) return `Edge id is longer than ${LIMITS.edgeId} characters.`;
    const long = tooLong(e, EDGE_LEN);
    if (long) return `Edge ${long[0]} is longer than ${long[1]} characters.`;
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
  // Stored JSON is never rewritten; a v1 spine converts to its graph on read.
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
    if (!wf || typeof wf !== 'object' || !Array.isArray(wf.nodes)) return { error: 'workflow must be an object with a nodes list.' };
    const tooLong = oversize(wf);
    if (tooLong) return { error: tooLong };
    return { draft: setDraft(normalizeWorkflow(wf), q('SELECT base_version FROM workflow_draft WHERE id = 1').get().base_version) };
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
  const versions = () => q('SELECT version, published_at FROM workflow_versions ORDER BY version DESC').all()
    .map((r) => ({ version: r.version, publishedAt: r.published_at, nodes: version(r.version).nodes.length }));

  // ---- runs ----
  const getRun = (id) => q('SELECT * FROM runs WHERE id = ?').get(String(id)) ?? null;
  // A run saved before the graph engine has no active_json: its one stage is the active node.
  const stateOf = (r) => ({
    active: r.active_json ? parse(r.active_json) : ENDED.includes(r.status) ? [] : [r.stage],
    joins: r.joins_json ? parse(r.joins_json) : {},
    round: r.round, status: r.status, verdict: r.verdict, ask: r.ask,
  });
  const nodeOf = (wf, id) => wf.nodes.find((n) => n.id === id);

  function summary(r) {
    const wf = version(r.workflow_version);
    const { active } = stateOf(r);
    const gate = r.status === 'waiting' ? active.map((id) => nodeOf(wf, id)).find((n) => n?.type === 'gate') : null;
    return {
      id: r.id, title: r.title, task: r.task, repo: r.repo, branch: r.branch, workflowVersion: r.workflow_version,
      stage: r.stage, stageName: nodeOf(wf, r.stage)?.name ?? r.stage,
      active: active.map((id) => ({ id, name: nodeOf(wf, id)?.name ?? id, type: nodeOf(wf, id)?.type ?? null })),
      round: r.round, maxRounds: wf.loop.maxRounds, status: r.status, verdict: r.verdict, ask: r.ask,
      actions: gate ? gate.actions.map(({ label }) => ({ label })) : [], textField: !!gate?.textField,
      note: r.note, createdAt: r.created_at, updatedAt: r.updated_at, endedAt: r.ended_at,
    };
  }

  function addEvent(runId, kind, { stage = null, round = null, verdict = null, note = null } = {}) {
    q('INSERT INTO run_events (run_id, at, kind, stage, round, verdict, note) VALUES (?, ?, ?, ?, ?, ?, ?)').run(runId, now(), kind, stage, round, verdict, note);
  }

  const openVisit = (runId, node, at, leftAt = null, outcome = null) => q(
    'INSERT INTO node_visits (run_id, node_id, entered_at, left_at, outcome) VALUES (?, ?, ?, ?, ?)').run(runId, node, at, leftAt, outcome);
  const closeVisit = (runId, node, at, outcome) => q(`UPDATE node_visits SET left_at = ?, outcome = ? WHERE id =
    (SELECT id FROM node_visits WHERE run_id = ? AND node_id = ? AND left_at IS NULL ORDER BY id DESC LIMIT 1)`).run(at, outcome, runId, node);
  const isEnd = (wf, id) => nodeOf(wf, id)?.type === 'end';

  // Writes a new state: the run row plus its node visits. `outcome` names how each left node ended (default 'cancelled').
  function save(r, state, { entered = [], left = [], outcome = () => 'cancelled', stage, note, answer } = {}) {
    const wf = version(r.workflow_version);
    const at = now();
    for (const id of left) closeVisit(r.id, id, at, outcome(id));
    for (const id of entered) openVisit(r.id, id, at, isEnd(wf, id) ? at : null);
    const ended = ENDED.includes(state.status);
    stage ??= state.active[0] ?? entered.find((id) => isEnd(wf, id)) ?? r.stage;
    q(`UPDATE runs SET stage = ?, active_json = ?, joins_json = ?, round = ?, status = ?, verdict = ?, ask = ?, note = ?,
       answer_json = ?, updated_at = ?, ended_at = ? WHERE id = ?`).run(stage, JSON.stringify(state.active), JSON.stringify(state.joins),
      state.round, state.status, state.verdict ?? null, state.ask ?? null, note ?? r.note,
      answer ? JSON.stringify(answer) : r.answer_json, at, ended ? (r.ended_at ?? at) : null, r.id);
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
    const at = now();
    q(`INSERT INTO runs (id, title, task, repo, branch, workflow_version, stage, active_json, joins_json, round, status, verdict, ask, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`).run(id, String(title).trim(), task ?? null, repo ?? null, branch ?? null,
      wf.version, state.active[0], JSON.stringify(state.active), JSON.stringify(state.joins), state.round, state.status, state.ask, note ?? null, at, at);
    for (const n of state.active) openVisit(id, n, at);
    addEvent(id, 'stage', { stage: state.active[0], round: 0, note: note || 'Run started' });
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
    return { run: save(r, res.state, { ...res, outcome: (n) => (n === stage ? outcome : 'cancelled'), note: note || r.note }) };
  });

  const respond = (id, { action, text }) => mutate(id, (r, wf) => {
    const res = engine.respond(wf, stateOf(r), { action, text });
    if (!res.ok) return { error: res.error };
    addEvent(id, 'answer', { stage: r.stage, round: r.round, note: res.answer.text ? `${res.answer.action}: ${res.answer.text}` : res.answer.action });
    return { run: save(r, res.state, { ...res, outcome: () => res.answer.action, answer: { ...res.answer, stage: r.stage } }) };
  });

  const stopRun = (id) => mutate(id, (r) => {
    if (ENDED.includes(r.status)) return { error: `Run is already ${r.status}.` };
    addEvent(id, 'stop', { stage: r.stage, round: r.round, note: 'Stopped' });
    const state = stateOf(r);
    return { run: save(r, engine.stop(state), { left: state.active, outcome: () => 'stopped', stage: 'stopped', answer: { action: 'Stop run', text: '', stage: r.stage } }) };
  });

  const logRun = (id, note) => mutate(id, (r) => {
    addEvent(id, 'log', { stage: r.stage, round: r.round, note });
    return { run: save(r, stateOf(r), { note }) };
  });

  function detail(id) {
    const r = getRun(id);
    if (!r) return null;
    const wf = version(r.workflow_version);
    const t = Date.now();
    const visits = q('SELECT node_id AS node, entered_at AS enteredAt, left_at AS leftAt, outcome FROM node_visits WHERE run_id = ? ORDER BY id').all(id);
    const nodes = Object.fromEntries(wf.nodes.map((n) => [n.id, { visits: 0, durationMs: 0 }]));
    for (const v of visits) {
      const n = Object.hasOwn(nodes, v.node) ? nodes[v.node] : (nodes[v.node] = { visits: 0, durationMs: 0 });
      n.visits += 1;
      n.durationMs += (v.leftAt ? Date.parse(v.leftAt) : t) - Date.parse(v.enteredAt);
    }
    return {
      run: summary(r), workflow: wf, visits, nodes,
      durationMs: (r.ended_at ? Date.parse(r.ended_at) : t) - Date.parse(r.created_at),
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
  // start_nodes: the run's active nodes when the agent appeared (token attribution uses it).
  const createAgent = (a) => {
    const run = getRun(a.runId);
    const startNodes = JSON.stringify(run ? stateOf(run).active : []);
    q(`INSERT OR IGNORE INTO agents (agent_id, run_id, session_id, type, transcript_path, transcript_offset, started_at, last_activity_at, start_nodes, reported_nodes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]')`).run(a.id, a.runId, a.sessionId ?? null, a.type ?? null, a.transcriptPath ?? null, a.offset ?? 0, now(), now(), startNodes);
    emit('agent', a.runId);
  };
  function updateAgent(id, fields) {
    const keys = Object.keys(fields).filter((k) => AGENT_COLUMNS.has(k));
    if (!keys.length) return;
    q(`UPDATE agents SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE agent_id = ?`).run(...keys.map((k) => fields[k] ?? null), id);
    emit('agent', getAgent(id)?.run_id);
  }
  // Records a stage an agent called complete_stage on (distinct, capped).
  function reportNode(agentId, node) {
    const a = getAgent(agentId);
    if (!a) return;
    const list = a.reported_nodes ? parse(a.reported_nodes) : [];
    if (list.includes(node) || list.length >= MAX_REPORTED) return;
    q('UPDATE agents SET reported_nodes = ? WHERE agent_id = ?').run(JSON.stringify([...list, node]), agentId);
  }
  function addActivity(runId, agentId, event, tool, text) {
    q('INSERT INTO activity (run_id, agent_id, at, event, tool, summary) VALUES (?, ?, ?, ?, ?, ?)').run(runId, agentId, now(), event, tool ?? null, text ?? null);
    q(`DELETE FROM activity WHERE run_id = ? AND id <= (SELECT id FROM activity WHERE run_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?)`).run(runId, runId, ACTIVITY_CAP);
    emit('activity', runId);
  }
  const activityCount = (runId) => q('SELECT COUNT(*) AS n FROM activity WHERE run_id = ?').get(runId).n;
  // Everything token attribution needs for one run (pure input for attributeRun), or null.
  function attributionInput(id) {
    const r = getRun(id);
    if (!r) return null;
    const rows = q('SELECT * FROM agents WHERE run_id = ? ORDER BY started_at, rowid').all(id);
    const list = (json) => (json ? parse(json) : []);
    return {
      run: { createdAt: r.created_at, endedAt: r.ended_at }, workflow: version(r.workflow_version),
      visits: q('SELECT node_id AS node, entered_at AS enteredAt, left_at AS leftAt FROM node_visits WHERE run_id = ? ORDER BY id').all(id),
      agents: rows.map((a) => ({ id: a.agent_id, type: a.type, description: a.description, startNodes: list(a.start_nodes), reportedNodes: list(a.reported_nodes) })),
      mainSessions: rows.filter((a) => a.type === 'main' && a.session_id).map((a) => a.session_id),
    };
  }
  const finishedRuns = () => q("SELECT id, workflow_version AS version, created_at AS createdAt, ended_at AS endedAt FROM runs WHERE status = 'done' ORDER BY created_at").all();
  const close = () => db.close();

  // ---- one-time migration from the v1 spine (user_version 0 -> 2) ----
  // Visits for a v1 run: each stage/answer/stop event closes the visit of its stage, which began at the previous
  // closing event (or the run start). The current stage keeps an open visit; a finished run visits its end node.
  function backfillVisits(r) {
    const wf = version(r.workflow_version);
    const labelOf = (stage, note) => nodeOf(wf, stage)?.actions?.find((a) => note === a.label || note?.startsWith(`${a.label}: `))?.label ?? null;
    let since = r.created_at;
    let last = null;
    for (const e of q("SELECT * FROM run_events WHERE run_id = ? AND kind IN ('stage', 'answer', 'stop') ORDER BY id").all(r.id)) {
      if (e.kind === 'stage' && e.verdict === null) continue; // the start marker
      const outcome = e.kind === 'stage' ? e.verdict : e.kind === 'stop' ? 'stopped' : labelOf(e.stage, e.note);
      openVisit(r.id, e.stage, since, e.at, outcome);
      since = e.at;
      last = e.kind;
    }
    if (!ENDED.includes(r.status)) openVisit(r.id, r.stage, since);
    else if (last !== 'stop') openVisit(r.id, r.stage, r.ended_at ?? since, r.ended_at ?? since);
  }
  function migrate() {
    if (q('PRAGMA user_version').get().user_version >= SCHEMA_VERSION) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, columns] of Object.entries(NEW_COLUMNS)) {
        const have = new Set(q(`PRAGMA table_info(${table})`).all().map((c) => c.name));
        for (const c of columns) if (!have.has(c)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${c} TEXT`);
      }
      for (const r of q('SELECT * FROM runs').all()) {
        if (!q('SELECT 1 FROM node_visits WHERE run_id = ?').get(r.id)) backfillVisits(r);
      }
      const latest = q('SELECT version, json FROM workflow_versions ORDER BY version DESC LIMIT 1').get();
      if (latest && !Array.isArray(parse(latest.json).nodes)) {
        const json = JSON.stringify(seedWorkflow());
        q('INSERT INTO workflow_versions (version, json, published_at) VALUES (?, ?, ?)').run(latest.version + 1, json, now());
        // An untouched draft follows the new seed; an edited one is kept (it converts on read).
        q('UPDATE workflow_draft SET json = ?, updated_at = ?, base_version = ? WHERE id = 1 AND json = ?').run(json, now(), latest.version + 1, latest.json);
      }
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
  migrate();

  return {
    bus, close, version, published, draft, saveDraft, resetDraft, loadVersion, publish, versions,
    getRun, summary, listRuns, startRun, completeStage, respond, stopRun, logRun, detail, attributionInput, finishedRuns,
    linkSession, touchSession, sessionRun, getAgent, createAgent, updateAgent, reportNode, addActivity, activityCount,
  };
}
