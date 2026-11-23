// Crew server (Hephaestus #2289, contract C6): parent link between agents and context fill per agent.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { windowFor, contextOf } from '../src/context.js';
import { tmp } from './helpers.js';
import { boot } from './holdout-helpers.js';

function setup() {
  const store = openStore(tmp());
  const projectsDir = tmp('am-projects');
  const hooks = createHooks(store, { projectsDir, defer: (fn) => fn(), clock: () => Date.now() });
  const sessionFile = path.join(projectsDir, 'proj', 's1.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, 'existing line\n');
  const { run } = store.startRun({ title: 'R1' });
  store.linkSession('s1', run.id);
  const send = (hook_event_name, extra = {}) => hooks.handle({ session_id: 's1', transcript_path: sessionFile, cwd: '/x', hook_event_name, ...extra });
  // agentId omitted = the main session calls the tool.
  const spawn = (toolUseId, agentId, tool = 'Agent') => send('PreToolUse', { tool_name: tool, tool_input: { description: 'go' }, tool_use_id: toolUseId, ...(agentId ? { agent_id: agentId } : {}) });
  const start = (agentId) => send('SubagentStart', { agent_id: agentId, agent_type: 'general-purpose' });
  const metaFile = (agentId) => path.join(projectsDir, 'proj', 's1', 'subagents', `agent-${agentId}.meta.json`);
  const writeMeta = (agentId, meta) => {
    fs.mkdirSync(path.dirname(metaFile(agentId)), { recursive: true });
    fs.writeFileSync(metaFile(agentId), JSON.stringify(meta));
  };
  const parentOf = (id) => store.detail(run.id).agents.find((a) => a.id === id)?.parentId;
  return { store, hooks, send, spawn, start, writeMeta, parentOf, runId: run.id };
}

test('parent via the meta.json toolUseId, including a helper started by a lead', () => {
  const t = setup();
  t.spawn('tu1'); // the main session starts the lead
  t.writeMeta('lead', { toolUseId: 'tu1', description: 'Lead' });
  t.start('lead');
  assert.equal(t.parentOf('lead'), 'main:s1');
  t.spawn('tu2', 'lead');
  t.spawn('tu3', 'lead'); // two open calls: only meta can tell them apart
  t.writeMeta('h1', { toolUseId: 'tu3' });
  t.start('h1');
  assert.equal(t.parentOf('h1'), 'lead');
  t.store.close();
});

test('parent via the pending Agent/Task call when there is no meta file', () => {
  const t = setup();
  t.spawn('tu1', undefined, 'Task');
  t.start('lead');
  assert.equal(t.parentOf('lead'), 'main:s1');
  assert.equal(t.parentOf('main:s1'), null);
  t.store.close();
});

test('two different pending parents and no meta: the parent stays null', () => {
  const t = setup();
  t.spawn('tu1');
  t.start('lead');
  t.spawn('tu2', 'lead'); // main's tu1 is still open too
  t.start('h1');
  assert.equal(t.parentOf('h1'), null);
  t.store.close();
});

test('a subagent is never its own parent', () => {
  const t = setup();
  t.start('a1'); // no pending call at all
  t.spawn('tu9', 'a1');
  t.writeMeta('a1', { toolUseId: 'tu9' }); // meta points at a call a1 made itself
  t.start('a1');
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x', agent_id: 'a1' });
  assert.equal(t.parentOf('a1'), null);
  t.store.close();
});

test('meta found only on a later token read fills the parent', () => {
  const t = setup();
  t.spawn('tu1');
  t.start('lead'); // fallback gives main:s1
  t.spawn('tu2', 'lead');
  t.start('h1'); // two parents pending, no meta yet: unknown
  assert.equal(t.parentOf('h1'), null);
  t.writeMeta('h1', { toolUseId: 'tu2' });
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x', agent_id: 'h1' });
  assert.equal(t.parentOf('h1'), 'lead');
  t.store.close();
});

test('meta overrides a parent that only came from the pending fallback', () => {
  const t = setup();
  t.spawn('tu2', 'lead'); // the lead's row appears here; its call is the only open one
  t.start('h2');
  assert.equal(t.parentOf('h2'), 'lead'); // a guess
  t.spawn('tu7'); // the main session's own call, which the meta file names
  t.writeMeta('h2', { toolUseId: 'tu7' });
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'x', agent_id: 'h2' });
  assert.equal(t.parentOf('h2'), 'main:s1');
  t.store.close();
});

test('a version-4 database keeps every row, gains parent_agent_id and moves to user_version 5', () => {
  const dir = tmp('am-crew-v4-');
  const s0 = openStore(dir);
  const rid = s0.startRun({ title: 'Old run' }).run.id;
  s0.createAgent({ id: 'main:s', runId: rid, sessionId: 's', type: 'main' });
  s0.createAgent({ id: 'old1', runId: rid, sessionId: 's', type: 'general-purpose' });
  s0.addActivity(rid, 'main:s', 'tool', 'Agent', 'x', 'tu1');
  s0.close();
  const raw = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  raw.exec('ALTER TABLE agents DROP COLUMN parent_agent_id; PRAGMA user_version = 4');
  raw.close();
  const s = openStore(dir);
  const d = s.detail(rid);
  assert.deepEqual(d.agents.map((a) => a.id), ['main:s', 'old1']);
  assert.ok(d.agents.every((a) => a.parentId === null));
  assert.equal(d.activity.length, 1);
  assert.equal(s.agentOfToolUse(rid, 'tu1'), 'main:s');
  assert.equal(s.agentOfToolUse(rid, 'nope'), null);
  s.updateAgent('old1', { parent_agent_id: 'main:s' });
  assert.equal(s.detail(rid).agents[1].parentId, 'main:s');
  s.close();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  assert.ok(db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'parent_agent_id'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5);
  db.close();
});

test('windowFor: longest prefix, unknown models get 200k', () => {
  assert.equal(windowFor('claude-opus-5-5'), 1_000_000);
  assert.equal(windowFor('claude-opus-5-5-20261101'), 1_000_000);
  assert.equal(windowFor('claude-sonnet-4-6'), 1_000_000);
  assert.equal(windowFor('claude-haiku-4-5'), 200_000);
  assert.equal(windowFor('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(windowFor('some-other-model'), 200_000);
  assert.equal(windowFor(null), 200_000);
});

test('contextOf: rounds, caps at 100 and is null when the token count is unknown', () => {
  assert.deepEqual(contextOf('claude-opus-5-5', 250_000), { tokens: 250_000, window: 1_000_000, pct: 25 });
  assert.equal(contextOf('claude-haiku-4-5', 500_000).pct, 100);
  assert.equal(contextOf('claude-opus-5-5', undefined), null);
  assert.equal(contextOf('claude-opus-5-5', 0), null);
});

const tline = (id, o) => JSON.stringify({ type: 'assistant', sessionId: o.session, ...(o.agent ? { agentId: o.agent } : {}), timestamp: o.ts,
  message: { id, model: o.model, usage: { input_tokens: o.input ?? 0, output_tokens: 5, cache_creation_input_tokens: o.cw ?? 0, cache_read_input_tokens: o.cr ?? 0 } } }) + '\n';

test('GET /api/runs/:id agents carry parentId and context; unknown context is null', async () => {
  const projects = tmp('am-proj-');
  const b = await boot({ projects });
  try {
    const { store, usage } = b.srv;
    const id = store.startRun({ title: 'Crew run' }).run.id;
    store.createAgent({ id: 'main:sess1', runId: id, sessionId: 'sess1', type: 'main' });
    store.createAgent({ id: 'lead', runId: id, sessionId: 'sess1', type: 'fable-lead' });
    store.createAgent({ id: 'small', runId: id, sessionId: 'sess1', type: 'haiku-engineer' });
    store.createAgent({ id: 'quiet', runId: id, sessionId: 'sess1', type: 'general-purpose' });
    store.createAgent({ id: 'codex:t1', runId: id, sessionId: 't1', type: 'codex', provider: 'codex' });
    store.updateAgent('lead', { parent_agent_id: 'main:sess1' });
    store.updateAgent('small', { parent_agent_id: 'lead' });
    const dir = path.join(projects, '-proj');
    fs.mkdirSync(path.join(dir, 'sess1', 'subagents'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'sess1.jsonl'),
      tline('m1', { session: 'sess1', model: 'claude-opus-5-5', input: 10, cr: 90_000, ts: '2026-11-01T10:00:00.000Z' })
      + tline('m2', { session: 'sess1', model: 'claude-opus-5-5', input: 20, cw: 5_000, cr: 245_000, ts: '2026-11-01T10:05:00.000Z' }));
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-lead.jsonl'),
      tline('l1', { session: 'sess1', agent: 'lead', model: 'claude-opus-5-5', cr: 100_000, ts: '2026-11-01T10:01:00.000Z' }));
    fs.writeFileSync(path.join(dir, 'sess1', 'subagents', 'agent-small.jsonl'),
      tline('s1', { session: 'sess1', agent: 'small', model: 'claude-haiku-4-5', cr: 300_000, ts: '2026-11-01T10:02:00.000Z' }));
    await usage.scan();
    await usage.scan();
    const d = (await b.api('GET', `/api/runs/${id}`)).json;
    const by = Object.fromEntries(d.agents.map((a) => [a.id, a]));
    assert.equal(by['main:sess1'].parentId, null);
    assert.equal(by.lead.parentId, 'main:sess1');
    assert.equal(by.small.parentId, 'lead');
    assert.deepEqual(by['main:sess1'].context, { tokens: 250_020, window: 1_000_000, pct: 25 }); // latest main message, not the sum
    assert.deepEqual(by.lead.context, { tokens: 100_000, window: 1_000_000, pct: 10 });
    assert.deepEqual(by.small.context, { tokens: 300_000, window: 200_000, pct: 100 }); // capped
    assert.equal(by.quiet.context, null);
    assert.equal(by['codex:t1'].context, null);
  } finally { await b.srv.close(); }
});
