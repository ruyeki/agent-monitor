// Holdout (#2288): activity end-marking by tool_use_id, the run-detail fields, no tool results stored, and the v3 -> v4 migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

function setup() {
  const dir = tmp('am-affect-');
  const store = openStore(dir);
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  const ev = (hook_event_name, extra = {}, sid = 'cs') => hooks.handle({ session_id: sid, cwd: '/x', hook_event_name, ...extra });
  const tools = (id = run.id) => store.detail(id).activity.filter((a) => a.event === 'tool');
  return { dir, store, hooks, ev, id: run.id, tools };
}
const pre = (t, id, cmd = 'echo hi', extra = {}) => t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: cmd }, ...(id === undefined ? {} : { tool_use_id: id }), ...extra });
const rowOf = (t, id) => t.tools().find((a) => a.toolUseId === id);

test('ok: PostToolUse marks the matching row ended with outcome ok and a time', () => {
  const t = setup();
  pre(t, 'u1');
  const open = rowOf(t, 'u1');
  assert.ok(open, 'row stores the tool_use_id');
  assert.equal(open.endedAt ?? null, null);
  assert.equal(open.outcome ?? null, null);
  t.ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_response: { stdout: 'hi' }, tool_use_id: 'u1' });
  const done = rowOf(t, 'u1');
  assert.equal(done.outcome, 'ok');
  assert.ok(Date.parse(done.endedAt) >= Date.parse(done.at), 'endedAt is an ISO time not before the start');
  assert.equal(done.id, open.id);
  t.store.close();
});

test('error: PostToolUseFailure marks the tool row error and the error row carries the same tool_use_id', () => {
  const t = setup();
  pre(t, 'u2');
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'u2', error: 'exit 1: boom' });
  assert.equal(rowOf(t, 'u2').outcome, 'error');
  assert.ok(rowOf(t, 'u2').endedAt);
  const err = t.store.detail(t.id).activity.find((a) => a.event === 'error');
  assert.equal(err.toolUseId, 'u2');
  assert.match(err.summary, /boom/);
  t.store.close();
});

test('no tool_use_id: nothing is marked and nothing throws; the row has a null id', () => {
  const t = setup();
  pre(t, undefined);
  assert.equal(t.tools()[0].toolUseId ?? null, null);
  assert.doesNotThrow(() => t.ev('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {} }));
  assert.doesNotThrow(() => t.ev('PostToolUseFailure', { tool_name: 'Bash', error: 'x' }));
  assert.doesNotThrow(() => t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: '' }));
  assert.doesNotThrow(() => t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 42 }));
  assert.equal(t.tools()[0].endedAt ?? null, null);
  assert.equal(t.tools()[0].outcome ?? null, null);
  assert.ok('toolUseId' in t.tools()[0], 'the key exists in the detail');
  t.store.close();
});

test('an unknown id marks nothing; a second end does not overwrite the first; other rows stay open', () => {
  const t = setup();
  pre(t, 'a'); pre(t, 'b'); pre(t, 'c');
  t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'zzz' });
  assert.ok(t.tools().every((r) => !r.endedAt));
  t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'b' });
  const first = rowOf(t, 'b').endedAt;
  assert.ok(first, 'b ended');
  assert.ok(rowOf(t, 'a').endedAt == null && rowOf(t, 'c').endedAt == null, 'only b ended');
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'b', error: 'late' });
  assert.equal(rowOf(t, 'b').outcome, 'ok', 'the first outcome wins');
  assert.equal(rowOf(t, 'b').endedAt, first);
  t.store.close();
});

test('the same tool_use_id in another run is not touched', () => {
  const t = setup();
  const other = t.store.startRun({ title: 'Other' }).run.id;
  t.store.linkSession('os', other);
  pre(t, 'dup');
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'dup' }, 'os');
  t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'dup' });
  assert.equal(t.tools(t.id).find((r) => r.toolUseId === 'dup').outcome, 'ok');
  assert.equal(t.tools(other).find((r) => r.toolUseId === 'dup').endedAt ?? null, null);
  t.store.close();
});

test('a subagent call is marked too (agent id kept on the row)', () => {
  const t = setup();
  t.ev('SubagentStart', { agent_id: 'ag1', agent_type: 'worker' });
  t.ev('PreToolUse', { agent_id: 'ag1', tool_name: 'Read', tool_input: { file_path: '/a' }, tool_use_id: 'sa1' });
  t.ev('PostToolUse', { agent_id: 'ag1', tool_name: 'Read', tool_use_id: 'sa1' });
  const r = rowOf(t, 'sa1');
  assert.equal(r.agentId, 'ag1');
  assert.equal(r.outcome, 'ok');
  t.store.close();
});

test('Codex payload without an id: a tool row is stored, nothing is marked, no throw; with an id it is marked', () => {
  const t = setup();
  t.store.markLimit(t.id, { at: new Date().toISOString(), source: 'stopfailure' });
  t.store.handOver(t.id);
  t.store.setCodexThread(t.id, 'thr');
  const cx = (n, extra) => t.hooks.handle({ session_id: 'thr', hook_event_name: n, ...extra }, 'codex');
  assert.doesNotThrow(() => cx('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }));
  assert.doesNotThrow(() => cx('PostToolUse', { tool_name: 'shell', tool_input: { command: 'ls' }, tool_response: 'files' }));
  const rows = t.tools();
  assert.ok(rows.length >= 1, 'codex tool row recorded');
  assert.ok(rows.every((r) => !r.endedAt && !r.outcome));
  assert.ok('toolUseId' in rows[0] && 'outcome' in rows[0], 'detail carries the new keys');
  cx('PreToolUse', { tool_name: 'shell', tool_input: { command: 'pwd' }, tool_use_id: 'cx1' });
  cx('PostToolUse', { tool_name: 'shell', tool_input: { command: 'pwd' }, tool_use_id: 'cx1' });
  assert.equal(rowOf(t, 'cx1')?.outcome, 'ok');
  t.store.close();
});

test('no tool result, error body or response content is stored anywhere (db file and detail)', () => {
  const t = setup();
  pre(t, 'sec1', 'echo visible');
  t.ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo visible' }, tool_use_id: 'sec1', tool_response: { stdout: 'RESULT-SECRET-7731', stderr: 'RESULT-SECRET-7731' } });
  pre(t, 'sec2');
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'sec2', error: 'short', tool_response: 'RESULT-SECRET-7731', error_details: 'RESULT-SECRET-7731' });
  const d = t.store.detail(t.id);
  assert.ok(!JSON.stringify(d).includes('RESULT-SECRET-7731'));
  assert.equal(rowOf(t, 'sec1')?.outcome, 'ok', 'end-marking did run');
  t.store.close();
  const db = new DatabaseSync(path.join(t.dir, 'agent-monitor.db'), { readOnly: true });
  const dump = JSON.stringify({ a: db.prepare('SELECT * FROM activity').all(), g: db.prepare('SELECT * FROM agents').all() });
  db.close();
  assert.ok(!dump.includes('RESULT-SECRET-7731'));
});

test('run detail: new keys id, toolUseId, endedAt, outcome; old keys kept; newest first; limit 100', () => {
  const t = setup();
  for (let i = 0; i < 130; i++) { pre(t, `n${i}`, `cmd ${i}`); if (i % 2) t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: `n${i}` }); }
  const act = t.store.detail(t.id).activity;
  assert.equal(act.length, 100);
  for (const k of ['id', 'toolUseId', 'endedAt', 'outcome', 'at', 'agentId', 'event', 'tool', 'summary']) assert.ok(k in act[0], k);
  assert.ok(act[0].id > act[1].id, 'newest first');
  assert.equal(act[0].toolUseId, 'n129');
  assert.equal(act[0].outcome, 'ok');
  assert.equal(act[1].outcome ?? null, null);
  t.store.close();
});

test('a very long tool_use_id is capped, not rejected', () => {
  const t = setup();
  assert.doesNotThrow(() => pre(t, 'x'.repeat(5000)));
  const row = t.tools()[0];
  assert.ok('toolUseId' in row);
  assert.ok(row.toolUseId == null || row.toolUseId.length <= 1000);
  t.store.close();
});

// ---- migration of a version-3 database that lacks the new columns
function v3Database() {
  const dir = tmp('am-affect-v3-');
  const s0 = openStore(dir);
  const rid = s0.startRun({ title: 'Old run' }).run.id;
  s0.addActivity(rid, 'main:s', 'tool', 'Bash', 'old summary');
  s0.close();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  const cols = db.prepare('PRAGMA table_info(activity)').all().map((c) => c.name);
  for (const c of ['tool_use_id', 'ended_at', 'outcome']) if (cols.includes(c)) db.exec(`ALTER TABLE activity DROP COLUMN ${c}`); // made to look like version 3
  db.exec('PRAGMA user_version = 3');
  db.close();
  return { dir, rid };
}

test('migration: a version-3 database keeps its rows, gains the three columns and moves to user_version 5', () => {
  const { dir, rid } = v3Database();
  const before = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  assert.deepEqual(before.prepare('PRAGMA table_info(activity)').all().map((c) => c.name).filter((c) => ['tool_use_id', 'ended_at', 'outcome'].includes(c)), [], 'fixture lacks the columns');
  assert.equal(before.prepare('PRAGMA user_version').get().user_version, 3);
  const runsBefore = before.prepare('SELECT COUNT(*) AS n FROM runs').get().n;
  before.close();
  const s = openStore(dir);
  const old = s.detail(rid).activity.find((a) => a.summary === 'old summary');
  assert.ok(old, 'old activity row kept');
  assert.ok('toolUseId' in old, 'new keys present on old rows');
  assert.equal(old.toolUseId ?? null, null);
  assert.equal(old.outcome ?? null, null);
  assert.equal(old.endedAt ?? null, null);
  s.addActivity(rid, 'main:s', 'tool', 'Bash', 'new one', 'mig1');
  s.endActivity(rid, 'mig1', 'ok');
  assert.equal(s.detail(rid).activity.find((a) => a.toolUseId === 'mig1').outcome, 'ok');
  s.close();
  const s2 = openStore(dir);
  assert.equal(s2.detail(rid).activity.length, 2);
  s2.close();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  const names = db.prepare('PRAGMA table_info(activity)').all().map((c) => c.name);
  for (const c of ['tool_use_id', 'ended_at', 'outcome']) assert.ok(names.includes(c), c);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM runs').get().n, runsBefore);
  db.close();
});

test('migration: a database already at version 4 opens again without error', () => {
  const dir = tmp('am-affect-v4-');
  openStore(dir).close();
  assert.doesNotThrow(() => openStore(dir).close());
});
