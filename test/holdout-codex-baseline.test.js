// Baseline: what the touched code does today (Claude-only). Must pass on the base commit and after the change.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCodex, denied, reason } from './holdout-codex-helpers.js';

let a;
before(async () => { a = await bootCodex({ codex: false }); });
after(async () => { await a.close(); });
const pre = (session, extra = {}) => a.post({ hook_event_name: 'PreToolUse', session_id: session, cwd: a.root, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `t${Math.random()}`, ...extra });

test('a Claude run moves through MCP, gates answer over REST, tokens and stats keep their shape', async () => {
  const id = await a.startRun('Base', { repo: 'r' });
  assert.match(await a.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' }), /WAITING ON RYAN/);
  const r = await a.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'x' } });
  assert.equal(r.status, 200);
  const d = await a.detail(id);
  assert.equal(d.run.stage, 'plan');
  assert.ok(Array.isArray(d.visits) && d.visits.length >= 2);
  for (const k of ['nodes', 'agents', 'tokens']) assert.ok(k in d, k);
  for (const k of ['nodes', 'main', 'unattributed', 'total']) assert.ok(k in d.tokens, `tokens.${k}`);
  const st = (await a.api('GET', '/api/stats/usage')).json;
  for (const k of ['indexer', 'periods', 'daily', 'unpricedModels']) assert.ok(k in st, k);
  for (const k of ['today', 'week', 'month', 'avg30']) assert.ok(k in st.periods, k);
});

test('hooks: unlinked sessions dropped; stopped run denies subagents but not main or agent-monitor tools', async () => {
  const id = await a.startRun('Hooks base');
  assert.deepEqual((await pre('nobody')).json, {});
  await a.link('hb', id);
  assert.deepEqual((await pre('hb')).json, {});
  await a.api('POST', `/api/runs/${id}/stop`);
  const r = await pre('hb', { agent_id: 'subStop' });
  assert.ok(denied(r));
  assert.equal(reason(r), `Agent Monitor: run ${id} was stopped by Ryan. Stop work and report back.`);
  assert.ok(!denied(await pre('hb')), 'main session not denied');
  assert.ok(!denied(await pre('hb', { agent_id: 'subStop', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id } })));
});

test('hooks: subagent self-API calls and respond are denied; main may respond; other errors are just activity', async () => {
  const id = await a.startRun('Guards base');
  await a.link('gb', id);
  assert.ok(denied(await pre('gb', { agent_id: 'sg', tool_input: { command: `curl http://127.0.0.1:${a.port}/api/runs` } })));
  assert.ok(denied(await pre('gb', { agent_id: 'sg', tool_name: 'mcp__agent-monitor__respond', tool_input: { run: id, action: 'x' } })));
  assert.ok(!denied(await pre('gb', { tool_input: { command: `curl http://127.0.0.1:${a.port}/api/runs` } })), 'main session may call the API');
  const r = await a.post({ hook_event_name: 'StopFailure', session_id: 'gb', cwd: a.root, error: 'overloaded' });
  assert.equal(r.status, 200);
  assert.equal((await a.detail(id)).run.status, 'active');
});

test('a stopped run keeps denying new subagents of the same session (the behaviour AC9 narrows)', async () => {
  const id = await a.startRun('Stopped base');
  await a.link('sb', id);
  await a.api('POST', `/api/runs/${id}/stop`);
  assert.ok(denied(await pre('sb', { agent_id: 'n1' })));
  assert.ok(denied(await pre('sb', { agent_id: 'n2' })));
});
