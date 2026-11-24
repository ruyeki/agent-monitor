// Post-only recording: tool calls, Ledger rows and subagent parents when PreToolUse never fires.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';
import { boot } from './holdout-helpers.js';

function setup(dir = tmp('am-post-only-')) {
  const store = openStore(dir);
  const projectsDir = tmp('am-proj-');
  const make = () => createHooks(store, { projectsDir, port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const t = { dir, store, projectsDir, hooks: make() };
  const sessionFile = path.join(projectsDir, 'proj', 's1.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, 'x\n');
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  t.id = run.id;
  const ev = (name, extra = {}) => t.hooks.handle({ session_id: 's1', transcript_path: sessionFile, cwd: '/x', hook_event_name: name, ...extra });
  const post = (id, extra = {}) => ev('PostToolUse', { tool_name: 'Read', tool_input: { file_path: '/a' }, tool_response: 'ok', tool_use_id: id, ...extra });
  const agent = (id) => store.detail(run.id).agents.find((a) => a.id === id);
  const toolRows = () => store.toolActivity(run.id);
  const metaFile = (aid) => path.join(projectsDir, 'proj', 's1', 'subagents', `agent-${aid}.meta.json`);
  const writeMeta = (aid, meta) => { fs.mkdirSync(path.dirname(metaFile(aid)), { recursive: true }); fs.writeFileSync(metaFile(aid), JSON.stringify(meta)); };
  const start = (aid) => ev('SubagentStart', { agent_id: aid, agent_type: 'general-purpose' });
  return Object.assign(t, { ev, post, agent, toolRows, writeMeta, start, restart: () => { t.hooks = make(); } });
}

test('a Post-only call is counted and its tool row is attributed to the subagent and ended', () => {
  const t = setup();
  t.post('u1', { agent_id: 'sub1', agent_type: 'worker' });
  t.ev('PostToolUseFailure', { agent_id: 'sub1', tool_name: 'Read', tool_input: { file_path: '/b' }, tool_use_id: 'u2', error: 'boom' });
  assert.equal(t.agent('sub1').toolCalls, 2);
  assert.equal(t.agent('sub1').lastTool, 'Read');
  const rows = t.toolRows();
  assert.deepEqual(rows.map((r) => [r.agentId, r.toolUseId, r.outcome]), [['sub1', 'u1', 'ok'], ['sub1', 'u2', 'error']]);
  assert.equal(t.agent('sub1').errors, 1);
  assert.ok(t.store.detail(t.id).activity.some((a) => a.event === 'error' && a.toolUseId === 'u2'));
  t.store.close();
});

test('a Post with no tool_use_id is not recorded', () => {
  const t = setup();
  t.post(undefined);
  assert.equal(t.toolRows().length, 0);
  t.store.close();
});

test('a Post-only change candidate writes a Ledger row with input and result, served by /ledger', async () => {
  const t = setup();
  t.post('c1', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_response: { stdout: '[main abc] x', stderr: '' } });
  t.ev('PostToolUseFailure', { agent_id: 'sub1', tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_use_id: 'c2', error: 'rejected' });
  const rows = t.store.changesOf(t.id);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].input, 'git push origin main');
  assert.match(rows[0].result, /abc/);
  assert.equal(rows[0].outcome, 'ok');
  assert.equal(rows[0].agentId, 'sub1');
  assert.equal(rows[1].outcome, 'error');
  assert.match(rows[1].result, /rejected/);
  t.store.close();
  const b = await boot({ home: t.dir });
  try {
    const r = await b.api('GET', `/api/runs/${t.id}/ledger`);
    assert.equal(r.status, 200);
    assert.ok(r.json.items.length >= 1);
    assert.match(r.text, /git push|[Pp]ush/);
  } finally { await b.srv.close(); }
});

test('Pre then Post counts once: one tool row, one change row', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'p1' });
  t.post('p1', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_response: { stdout: 'done' } });
  assert.equal(t.agent('main:s1').toolCalls, 1);
  assert.equal(t.toolRows().length, 1);
  assert.equal(t.store.changesOf(t.id).length, 1);
  assert.equal(t.store.changesOf(t.id)[0].result, 'done');
  t.store.close();
});

test('Pre, a restart (pending lost), then Post still counts once', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_use_id: 'p1' });
  t.restart();
  t.post('p1', { tool_name: 'Bash', tool_input: { command: 'git push' }, tool_response: { stdout: 'done' } });
  assert.equal(t.agent('main:s1').toolCalls, 1);
  assert.equal(t.toolRows().length, 1);
  assert.equal(t.toolRows()[0].outcome, 'ok');
  assert.equal(t.store.changesOf(t.id).length, 1);
  t.store.close();
});

test('the start_run linking Post is not counted; a monitor call on a linked run is', () => {
  const dir = tmp('am-post-only-');
  const store = openStore(dir);
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), defer: (fn) => fn() });
  const { run } = store.startRun({ title: 'R' });
  hooks.handle({ session_id: 'ns', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__start_run', tool_input: {}, tool_response: `RUN ${run.id} started`, tool_use_id: 'm1' });
  assert.equal(store.toolActivity(run.id).length, 0);
  assert.equal(store.detail(run.id).agents.find((a) => a.id === 'main:ns').toolCalls, 0);
  hooks.handle({ session_id: 'ns', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__log', tool_input: { run: run.id, note: 'n' }, tool_response: 'ok', tool_use_id: 'm2' });
  assert.equal(store.toolActivity(run.id).length, 1);
  assert.equal(store.detail(run.id).agents.find((a) => a.id === 'main:ns').toolCalls, 1);
  hooks.handle({ session_id: 'ns', hook_event_name: 'PostToolUseFailure', tool_name: 'mcp__agent-monitor__log', tool_input: { run: run.id }, error: 'bad', tool_use_id: 'm3' });
  assert.equal(store.toolActivity(run.id).find((r) => r.toolUseId === 'm3').outcome, 'error');
  store.close();
});

test('parents: depth-2 parentAgentId and depth-1 spawnDepth, with no PreToolUse', () => {
  const t = setup();
  t.post('x0'); // creates main:s1
  t.writeMeta('lead', { toolUseId: 'tu1', spawnDepth: 1 });
  t.start('lead');
  assert.equal(t.agent('lead').parentId, 'main:s1');
  t.writeMeta('h1', { toolUseId: 'tu2', parentAgentId: 'lead', spawnDepth: 2 });
  t.start('h1');
  assert.equal(t.agent('h1').parentId, 'lead');
  t.writeMeta('h2', { toolUseId: 'tu3', parentAgentId: 'h2' }); // never itself
  t.start('h2');
  assert.equal(t.agent('h2').parentId, null);
  t.store.close();
});

test('a toolUseId-only meta is resolved when the spawning Agent call Post arrives (main->sub and sub->sub)', () => {
  const t = setup();
  t.post('x0');
  t.writeMeta('lead', { toolUseId: 'tuA' });
  t.start('lead');
  assert.equal(t.agent('lead').parentId, null);
  t.post('tuA', { tool_name: 'Agent', tool_input: { description: 'go' } });
  assert.equal(t.agent('lead').parentId, 'main:s1');
  t.writeMeta('h1', { toolUseId: 'tuB' });
  t.start('h1');
  assert.equal(t.agent('h1').parentId, null);
  t.post('tuB', { agent_id: 'lead', tool_name: 'Task', tool_input: { description: 'go' } });
  assert.equal(t.agent('h1').parentId, 'lead');
  t.store.close();
});

test('the activity endpoint: one agent, newest first, limit clamped, 400 and 404 and []', async () => {
  const t = setup();
  for (let i = 0; i < 205; i++) t.post(`u${i}`, { agent_id: 'sub1' });
  t.post('o1', { agent_id: 'sub2' });
  t.store.close();
  const b = await boot({ home: t.dir });
  try {
    const url = (q) => `/api/runs/${t.id}/activity${q}`;
    let r = await b.api('GET', url('?agent=sub1'));
    assert.equal(r.status, 200);
    assert.equal(r.json.length, 50);
    assert.ok(r.json.every((x) => x.agentId === 'sub1'));
    assert.ok(r.json[0].id > r.json[1].id);
    assert.equal(r.json[0].toolUseId, 'u204');
    assert.deepEqual(Object.keys(r.json[0]).sort(), ['agentId', 'at', 'endedAt', 'event', 'id', 'outcome', 'summary', 'tool', 'toolUseId']);
    assert.equal((await b.api('GET', url('?agent=sub1&limit=7'))).json.length, 7);
    assert.equal((await b.api('GET', url('?agent=sub1&limit=9999'))).json.length, 200);
    assert.equal((await b.api('GET', url('?agent=sub1&limit=0'))).json.length, 1);
    assert.equal((await b.api('GET', url('?agent=sub1&limit=abc'))).json.length, 50);
    assert.equal((await b.api('GET', url('?agent=sub1&limit='))).json.length, 50, 'an empty limit means the default');
    assert.equal((await b.api('GET', url('?agent=sub2'))).json.length, 1);
    assert.deepEqual((await b.api('GET', url('?agent=nobody'))).json, []);
    r = await b.api('GET', url(''));
    assert.equal(r.status, 400);
    assert.ok(r.json.error);
    assert.equal((await b.api('GET', url('?agent='))).status, 400);
    r = await b.api('GET', '/api/runs/nope/activity?agent=sub1');
    assert.equal(r.status, 404);
    assert.ok(r.json.error);
  } finally { await b.srv.close(); }
});
