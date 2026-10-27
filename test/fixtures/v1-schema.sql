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
