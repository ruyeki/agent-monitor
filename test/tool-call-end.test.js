import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

function setup() {
  const store = openStore(tmp());
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), defer: (fn) => fn(), clock: () => Date.parse('2026-11-22T10:00:00Z') });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  const send = (hook_event_name, extra = {}) => hooks.handle({ session_id: 's1', cwd: '/x', hook_event_name, ...extra });
  const tools = () => store.detail(run.id).activity.filter((a) => a.event === 'tool');
  return { store, id: run.id, send, tools, activity: () => store.detail(run.id).activity };
}

test('PostToolUse marks the tool row ended with outcome ok', () => {
  const t = setup();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  const [row] = t.tools();
  assert.equal(row.toolUseId, 'a');
  assert.equal(row.endedAt, null);
  assert.equal(row.outcome, null);
  assert.equal(typeof row.id, 'number');
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: 'SECRET OUTPUT', tool_use_id: 'a' });
  const [ended] = t.tools();
  assert.equal(ended.outcome, 'ok');
  assert.match(ended.endedAt, /^\d{4}-\d\d-\d\dT/);
  assert.equal(JSON.stringify(t.activity()).includes('SECRET OUTPUT'), false);
});

test('PostToolUseFailure marks the tool row error and the error row keeps the tool_use_id', () => {
  const t = setup();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'b' });
  t.send('PostToolUseFailure', { tool_name: 'Bash', error: 'exit 1', tool_use_id: 'b' });
  const tool = t.tools()[0];
  assert.equal(tool.outcome, 'error');
  assert.ok(tool.endedAt);
  assert.equal(tool.summary, 'x'); // nothing new stored on the tool row
  const err = t.activity().find((a) => a.event === 'error');
  assert.equal(err.toolUseId, 'b');
  assert.equal(err.summary, 'exit 1');
});

test('a second end for the same call does not overwrite the first', () => {
  const t = setup();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' });
  t.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'a' });
  const first = t.tools()[0].endedAt;
  t.send('PostToolUseFailure', { tool_name: 'Bash', error: 'late', tool_use_id: 'a' });
  assert.equal(t.tools()[0].outcome, 'ok');
  assert.equal(t.tools()[0].endedAt, first);
});

test('no tool_use_id, an unknown one or a non-string one never throws and marks nothing', () => {
  const t = setup();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.deepEqual(t.send('PostToolUse', { tool_name: 'Bash' }), {});
  assert.deepEqual(t.send('PostToolUse', { tool_name: 'Bash', tool_use_id: 'nope' }), {});
  assert.deepEqual(t.send('PostToolUseFailure', { tool_name: 'Bash', error: 'e', tool_use_id: 42 }), {});
  const [row] = t.tools();
  assert.equal(row.toolUseId, null);
  assert.equal(row.endedAt, null);
  assert.equal(row.outcome, null);
  t.store.endActivity(t.id, undefined, 'ok');
  t.store.endActivity('no-such-run', 'a', 'ok');
  assert.equal(t.tools()[0].outcome, null);
});

test('a Codex payload without tool_use_id keeps working', () => {
  const store = openStore(tmp());
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), defer: (fn) => fn() });
  const { run } = store.startRun({ title: 'R' });
  store.markLimit(run.id, { at: new Date().toISOString(), source: 'stopfailure' });
  store.handOver(run.id);
  store.setCodexThread(run.id, 'thr');
  const codex = (hook_event_name, extra = {}) => hooks.handle({ session_id: 'thr', hook_event_name, ...extra }, 'codex');
  assert.deepEqual(codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }), {});
  assert.deepEqual(codex('PostToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }), {});
  codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'pwd' }, tool_use_id: 'c1' });
  codex('PostToolUse', { tool_name: 'shell', tool_use_id: 'c1' });
  const tools = store.detail(run.id).activity.filter((a) => a.event === 'tool');
  assert.equal(tools.length, 2);
  assert.equal(tools.find((a) => a.toolUseId === 'c1').outcome, 'ok');
  assert.equal(tools.find((a) => a.toolUseId === null).outcome, null);
});

test('endActivity ends only tool rows of its own run', () => {
  const t = setup();
  const other = t.store.startRun({ title: 'Other' }).run.id;
  t.store.addActivity(t.id, 'a1', 'tool', 'Bash', 'ls', 'dup');
  t.store.addActivity(other, 'a1', 'tool', 'Bash', 'ls', 'dup');
  t.store.addActivity(t.id, 'a1', 'error', 'Bash', 'boom', 'dup2');
  t.store.endActivity(t.id, 'dup', 'ok');
  t.store.endActivity(t.id, 'dup2', 'ok');
  assert.equal(t.tools()[0].outcome, 'ok');
  assert.equal(t.store.detail(other).activity[0].outcome, null);
  assert.equal(t.activity().find((a) => a.event === 'error').outcome, null);
});

test('detail().activity returns the new keys and keeps the old ones, newest first', () => {
  const t = setup();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'one' }, tool_use_id: 'a' });
  t.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/f' }, tool_use_id: 'b' });
  const [newest, older] = t.activity();
  for (const k of ['id', 'at', 'agentId', 'event', 'tool', 'summary', 'toolUseId', 'endedAt', 'outcome']) assert.ok(k in newest, k);
  assert.equal(newest.tool, 'Read');
  assert.equal(older.tool, 'Bash');
  assert.ok(newest.id > older.id);
});

test('schema 3 -> 4: a v3 database without the activity columns keeps its rows and reaches version 4', (t) => {
  const dir = tmp();
  const first = openStore(dir);
  const { run } = first.startRun({ title: 'Old' });
  first.addActivity(run.id, 'a1', 'tool', 'Bash', 'ls');
  first.close();
  const file = path.join(dir, 'agent-monitor.db');
  const raw = new DatabaseSync(file);
  raw.exec('ALTER TABLE activity DROP COLUMN tool_use_id; ALTER TABLE activity DROP COLUMN ended_at; ALTER TABLE activity DROP COLUMN outcome; PRAGMA user_version = 3');
  raw.close();
  const store = openStore(dir);
  t.after(() => store.close());
  const check = new DatabaseSync(file);
  const cols = check.prepare('PRAGMA table_info(activity)').all().map((c) => c.name);
  assert.ok(['tool_use_id', 'ended_at', 'outcome'].every((c) => cols.includes(c)));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 5);
  check.close();
  const [row] = store.detail(run.id).activity;
  assert.equal(row.summary, 'ls');
  assert.equal(row.toolUseId, null);
  assert.equal(row.outcome, null);
  store.addActivity(run.id, 'a1', 'tool', 'Read', 'f', 'z');
  store.endActivity(run.id, 'z', 'ok');
  assert.equal(store.detail(run.id).activity[0].outcome, 'ok');
});
