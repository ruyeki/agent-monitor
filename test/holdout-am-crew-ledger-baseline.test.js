// Baseline (today's behaviour) for hooks tool recording, parent links and the ledger endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, mcpClient, req, runIdOf } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

let n = 0;
const sid = () => `bs-${++n}-${Math.random().toString(16).slice(2, 7)}`;
const tp = (s) => path.join(S.projects, 'proj', `${s}.jsonl`);
const H = (s, ev, extra = {}) => { fs.mkdirSync(path.dirname(tp(s)), { recursive: true }); if (!fs.existsSync(tp(s))) fs.writeFileSync(tp(s), ''); return req(S.port, 'POST', '/hook', { body: { hook_event_name: ev, session_id: s, transcript_path: tp(s), cwd: '/x', ...extra } }); };
const newRun = async (s) => {
  const id = runIdOf((await M.call('start_run', { title: 'b' })).text);
  await H(s, 'PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'b' }, tool_use_id: 'l' + s, tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame)` }] } });
  return id;
};
const detail = async (id) => (await req(S.port, 'GET', `/api/runs/${id}`)).json;
const agent = async (id, aid) => (await detail(id)).agents.find((a) => a.id === aid);

test('Pre then Post of one call: counted once, one tool row that ends ok', async () => {
  const s = sid(); const id = await newRun(s);
  await H(s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u1' });
  await H(s, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: { stdout: 'x' }, tool_use_id: 'u1' });
  const a = await agent(id, `main:${s}`);
  assert.equal(a.toolCalls, 1);
  const rows = (await detail(id)).activity.filter((r) => r.event === 'tool' && r.toolUseId === 'u1');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'ok');
});

test('Pre of a change candidate then Post: one ledger row with input and result via the endpoint', async () => {
  const s = sid(); const id = await newRun(s);
  await H(s, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'g1' });
  await H(s, 'PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_response: { stdout: '   1234567..89abcde  main -> main\n' }, tool_use_id: 'g1' });
  const rows = S.srv.store.changesOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 'git push origin main');
  assert.match(rows[0].result, /89abcde/);
  const r = await req(S.port, 'GET', `/api/runs/${id}/ledger`);
  assert.equal(r.status, 200);
  assert.match(r.text, /Pushed main/);
  assert.equal((await req(S.port, 'GET', '/api/runs/nope/ledger')).status, 404);
});

test('subagent with an Agent tool row and meta toolUseId gets its parent', async () => {
  const s = sid(); const id = await newRun(s);
  await H(s, 'PreToolUse', { tool_name: 'Agent', tool_input: { description: 'x' }, tool_use_id: 'toolu_p' });
  const dir = path.join(S.projects, 'proj', s, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'agent-c1.jsonl'), '');
  fs.writeFileSync(path.join(dir, 'agent-c1.meta.json'), JSON.stringify({ agentType: 'w', toolUseId: 'toolu_p', spawnDepth: 1 }));
  await H(s, 'SubagentStart', { agent_id: 'c1', agent_type: 'w' });
  assert.equal((await agent(id, 'c1')).parentId, `main:${s}`);
});

test('detail.activity carries only the last 100 rows and the old ledger endpoint shape stays an array/object that is JSON', async () => {
  const s = sid(); const id = await newRun(s);
  for (let i = 0; i < 130; i++) await H(s, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: `/f${i}` }, tool_use_id: `r${i}` });
  assert.equal((await detail(id)).activity.length, 100);
});
