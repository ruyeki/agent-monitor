// Baseline (#2289): what the store, hooks and run-detail API do today, so the Crew/Ledger tracking cannot break them.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { boot, hook, mcpClient, runIdOf, tmp, mainFile, subFile } from './holdout-v2-helpers.js';

function setup() {
  const store = openStore(tmp('am-bl-'));
  const projectsDir = tmp('am-bl-proj-');
  const hooks = createHooks(store, { projectsDir, port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  const ev = (hook_event_name, extra = {}, sid = 'cs') => hooks.handle({ session_id: sid, cwd: '/x', hook_event_name, ...extra });
  return { store, hooks, ev, id: run.id, projectsDir };
}

test('run detail: agents keep their current fields and activity rows keep theirs', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'x1' });
  t.ev('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const d = t.store.detail(t.id);
  const a = d.agents.find((x) => x.id === 'a1');
  for (const k of ['id', 'type', 'status', 'tokens', 'lastTool', 'lastSummary', 'description', 'model']) assert.ok(k in a, `agent.${k}`);
  assert.equal(a.type, 'worker');
  assert.deepEqual(Object.keys(a.tokens).sort(), ['cacheCreation', 'cacheRead', 'input', 'output']);
  const row = d.activity.find((r) => r.toolUseId === 'x1');
  for (const k of ['id', 'at', 'agentId', 'event', 'tool', 'summary', 'toolUseId', 'endedAt', 'outcome']) assert.ok(k in row, `activity.${k}`);
  assert.equal(row.tool, 'Bash');
  assert.equal(row.summary, 'echo hi');
});

test('activity: summary keeps 120 chars of the input and a run keeps at most 500 rows', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x'.repeat(500) }, tool_use_id: 'long' });
  assert.ok(t.store.detail(t.id).activity.find((r) => r.toolUseId === 'long').summary.length <= 120);
  for (let i = 0; i < 520; i++) t.store.addActivity(t.id, 'main:cs', 'tool', 'Bash', `c${i}`, `k${i}`);
  const all = t.store.detail(t.id).activity;
  assert.ok(all.length <= 100, 'detail shows the last 100');
  assert.equal(all[0].summary, 'c519', 'newest first');
});

test('Pre/Post/Failure still mark outcome by tool_use_id; a subagent of the linked session joins the run', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'a' }, tool_use_id: 'u1' });
  t.ev('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1' });
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'b' }, tool_use_id: 'u2' });
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'u2', error: 'boom' });
  const rows = t.store.detail(t.id).activity.filter((r) => r.event === 'tool');
  assert.equal(rows.find((r) => r.toolUseId === 'u1').outcome, 'ok');
  assert.equal(rows.find((r) => r.toolUseId === 'u2').outcome, 'error');
  t.ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/x' }, tool_use_id: 's1', agent_id: 'sub1', agent_type: 'worker' });
  assert.ok(t.store.detail(t.id).agents.some((a) => a.id === 'sub1'));
});

test('GET /api/runs/:id: agents carry attribution tokens with cost, the run carries totals, unknown run is 404', async () => {
  const S = await boot();
  try {
    const mcp = await mcpClient(S.url);
    const id = runIdOf((await mcp.call('start_run', { title: 'API run' })).text);
    const tp = mainFile(S.projects, 's1'); fs.mkdirSync(path.dirname(tp), { recursive: true }); fs.writeFileSync(tp, '');
    await hook(S.port, { hook_event_name: 'PostToolUse', session_id: 's1', transcript_path: tp, cwd: '/x', tool_name: 'mcp__agent-monitor__start_run', tool_input: {}, tool_use_id: 'l', tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame)` }] } });
    await hook(S.port, { hook_event_name: 'PreToolUse', session_id: 's1', transcript_path: tp, cwd: '/x', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'p' });
    fs.mkdirSync(path.dirname(subFile(S.projects, 's1', 'z9')), { recursive: true });
    await hook(S.port, { hook_event_name: 'SubagentStart', session_id: 's1', transcript_path: tp, cwd: '/x', agent_id: 'z9', agent_type: 'worker' });
    const r = await S.api('GET', `/api/runs/${id}`);
    assert.equal(r.status, 200);
    for (const a of r.json.agents) assert.ok('cost' in a.tokens && 'total' in a.tokens, `tokens for ${a.id}`);
    assert.ok(r.json.tokens.total && 'cost' in r.json.tokens.total);
    assert.ok(Array.isArray(r.json.activity) && r.json.workflow && r.json.run.id === id);
    assert.equal((await S.api('GET', '/api/runs/nope')).status, 404);
    assert.equal((await S.api('GET', '/api/runs')).status, 200);
  } finally { await S.srv.close(); }
});
