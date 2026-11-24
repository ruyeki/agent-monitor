// Holdout: tool calls recorded from Post events only; parents without PreToolUse; the per-agent activity endpoint.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, mcpClient, req, runIdOf } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

let n = 0;
const sid = () => `hs-${++n}-${Math.random().toString(16).slice(2, 7)}`;
const tp = (s) => path.join(S.projects, 'proj', `${s}.jsonl`);
const H = (s, ev, extra = {}) => { fs.mkdirSync(path.dirname(tp(s)), { recursive: true }); if (!fs.existsSync(tp(s))) fs.writeFileSync(tp(s), ''); return req(S.port, 'POST', '/hook', { body: { hook_event_name: ev, session_id: s, transcript_path: tp(s), cwd: '/x', ...extra } }); };
const newRun = async (s) => {
  const id = runIdOf((await M.call('start_run', { title: 'h' })).text);
  await H(s, 'PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'h' }, tool_use_id: 'l' + s, tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame)` }] } });
  return id;
};
const get = async (p) => req(S.port, 'GET', p);
const detail = async (id) => (await get(`/api/runs/${id}`)).json;
const agent = async (id, aid) => (await detail(id)).agents.find((a) => a.id === aid);
const post = (s, id, tool, input, extra = {}, resp = { stdout: 'ok' }) => H(s, 'PostToolUse', { tool_name: tool, tool_input: input, tool_response: resp, tool_use_id: id, ...extra });
const meta = (s, aid, m) => {
  const dir = path.join(S.projects, 'proj', s, 'subagents'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `agent-${aid}.jsonl`), '');
  fs.writeFileSync(path.join(dir, `agent-${aid}.meta.json`), JSON.stringify(m));
};
const toolRows = async (id, aid) => (await detail(id)).activity.filter((r) => r.event === 'tool' && r.agentId === aid);

test('AC1 Post-only: the main agent call is counted and recorded as a tool row', async () => {
  const s = sid(); const id = await newRun(s);
  await post(s, 'p1', 'Bash', { command: 'ls -la' });
  const a = await agent(id, `main:${s}`);
  assert.equal(a.toolCalls, 1);
  assert.equal(a.lastTool, 'Bash');
  const rows = await toolRows(id, `main:${s}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].toolUseId, 'p1');
  assert.match(rows[0].summary, /ls -la/);
  assert.ok(rows[0].endedAt, 'row ended');
  assert.equal(rows[0].outcome, 'ok');
});

test('AC1 Post-only: a subagent call is counted for that subagent, not main', async () => {
  const s = sid(); const id = await newRun(s);
  await post(s, 'p2', 'Read', { file_path: '/a' }, { agent_id: 'subx', agent_type: 'sonnet-engineer' });
  await post(s, 'p3', 'Read', { file_path: '/b' }, { agent_id: 'subx', agent_type: 'sonnet-engineer' });
  assert.equal((await agent(id, 'subx')).toolCalls, 2);
  assert.equal((await toolRows(id, 'subx')).length, 2);
  assert.equal((await agent(id, `main:${s}`))?.toolCalls ?? 0, 0);
});

test('AC1 Post-only failure: counted, recorded as an error outcome', async () => {
  const s = sid(); const id = await newRun(s);
  await H(s, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'false' }, error: 'exit 1', tool_use_id: 'f1' });
  const a = await agent(id, `main:${s}`);
  assert.equal(a.toolCalls, 1);
  const rows = await toolRows(id, `main:${s}`);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'error');
  assert.equal(a.errors, 1);
});

test('AC1 Post-only ledger: change candidate writes a row with input AND result, served by /ledger', async () => {
  const s = sid(); const id = await newRun(s);
  await post(s, 'g1', 'Bash', { command: 'git push origin feat/x' }, {}, { stdout: '   1234567..89abcde  feat/x -> feat/x\n' });
  const rows = S.srv.store.changesOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].input, 'git push origin feat/x');
  assert.match(rows[0].result, /89abcde/);
  assert.equal(rows[0].outcome, 'ok');
  assert.ok(rows[0].endedAt);
  const r = await get(`/api/runs/${id}/ledger`);
  assert.equal(r.status, 200);
  assert.match(r.text, /feat\/x/);
  assert.match(r.text, /89abcde/);
});

test('AC1 Post-only: non-candidate calls write no change rows; failed candidate ends as error', async () => {
  const s = sid(); const id = await newRun(s);
  await post(s, 'n1', 'Bash', { command: 'git status' });
  assert.equal(S.srv.store.changesOf(id).length, 0);
  await H(s, 'PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, error: 'rejected', tool_use_id: 'g2' });
  const rows = S.srv.store.changesOf(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].outcome, 'error');
  assert.match(rows[0].input, /git push/);
});

test('AC1 Post-only: secrets in a recorded change are still redacted', async () => {
  const s = sid(); const id = await newRun(s);
  const tok = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
  await post(s, 'g3', 'Bash', { command: `git push https://x:${tok}@github.com/o/r.git main` }, {}, { stdout: `leak ${tok}` });
  const blob = JSON.stringify(S.srv.store.changesOf(id)) + (await get(`/api/runs/${id}/ledger`)).text; // activity summary leaks on base too (pre-existing), so not asserted
  assert.ok(!blob.includes(tok), 'token leaked');
});

test('AC2 Pre then Post (and a repeated Post) never double counts', async () => {
  const s = sid(); const id = await newRun(s);
  const inp = { command: 'git push origin main' };
  await H(s, 'PreToolUse', { tool_name: 'Bash', tool_input: inp, tool_use_id: 'd1' });
  await post(s, 'd1', 'Bash', inp, {}, { stdout: '89abcde' });
  await post(s, 'd1', 'Bash', inp, {}, { stdout: '89abcde' }); // hook retry
  const a = await agent(id, `main:${s}`);
  assert.equal(a.toolCalls, 1);
  assert.equal((await toolRows(id, `main:${s}`)).length, 1);
  assert.equal(S.srv.store.changesOf(id).length, 1);
});

test('AC2 two different Pre/Post calls count twice (no over-dedupe)', async () => {
  const s = sid(); const id = await newRun(s);
  for (const u of ['e1', 'e2']) { await H(s, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: u }, tool_use_id: u }); await post(s, u, 'Read', { file_path: u }); }
  assert.equal((await agent(id, `main:${s}`)).toolCalls, 2);
});

test('AC3 depth 1 without PreToolUse or an Agent row: parent is the main agent', async () => {
  const s = sid(); const id = await newRun(s);
  meta(s, 'dep1', { agentType: 'fable-lead', toolUseId: 'toolu_never_seen', spawnDepth: 1 });
  await post(s, 'q1', 'Read', { file_path: '/a' }, { agent_id: 'dep1', agent_type: 'fable-lead' });
  assert.equal((await agent(id, 'dep1')).parentId, `main:${s}`);
});

test('AC3 depth 1 via SubagentStart then a Post: parent is main', async () => {
  const s = sid(); const id = await newRun(s);
  meta(s, 'dep1b', { agentType: 'fable-lead', toolUseId: 'toolu_x1', spawnDepth: 1 });
  await H(s, 'SubagentStart', { agent_id: 'dep1b', agent_type: 'fable-lead' });
  await post(s, 'q2', 'Read', { file_path: '/a' }, { agent_id: 'dep1b' });
  assert.equal((await agent(id, 'dep1b')).parentId, `main:${s}`);
});

test('AC3 depth 2: parent is the named parentAgentId (subagent -> subagent)', async () => {
  const s = sid(); const id = await newRun(s);
  meta(s, 'lead9', { agentType: 'fable-lead', toolUseId: 'toolu_l', spawnDepth: 1 });
  await post(s, 'q3', 'Read', { file_path: '/a' }, { agent_id: 'lead9', agent_type: 'fable-lead' });
  meta(s, 'eng9', { agentType: 'sonnet-engineer', toolUseId: 'toolu_e', parentAgentId: 'lead9', spawnDepth: 2 });
  await post(s, 'q4', 'Edit', { file_path: '/a' }, { agent_id: 'eng9', agent_type: 'sonnet-engineer' });
  assert.equal((await agent(id, 'eng9')).parentId, 'lead9');
  assert.equal((await agent(id, 'lead9')).parentId, `main:${s}`);
});

test('AC3 depth 2 whose meta appears only after the first event is still linked later', async () => {
  const s = sid(); const id = await newRun(s);
  await post(s, 'q5', 'Read', { file_path: '/a' }, { agent_id: 'lead8', agent_type: 'fable-lead' });
  await post(s, 'q6', 'Read', { file_path: '/a' }, { agent_id: 'eng8', agent_type: 'sonnet-engineer' });
  meta(s, 'lead8', { agentType: 'fable-lead', toolUseId: 'toolu_l8', spawnDepth: 1 });
  meta(s, 'eng8', { agentType: 'sonnet-engineer', toolUseId: 'toolu_e8', parentAgentId: 'lead8', spawnDepth: 2 });
  await new Promise((r) => setTimeout(r, 5200)); // the 5 s re-read throttle
  await post(s, 'q7', 'Read', { file_path: '/b' }, { agent_id: 'eng8' });
  await post(s, 'q8', 'Read', { file_path: '/b' }, { agent_id: 'lead8' });
  assert.equal((await agent(id, 'eng8')).parentId, 'lead8');
  assert.equal((await agent(id, 'lead8')).parentId, `main:${s}`);
});

test('AC3 a meta naming the agent itself as parent, or no meta, leaves no self loop and no parent', async () => {
  const s = sid(); const id = await newRun(s);
  meta(s, 'selfy', { agentType: 'w', toolUseId: 't', parentAgentId: 'selfy', spawnDepth: 2 });
  await post(s, 'q9', 'Read', { file_path: '/a' }, { agent_id: 'selfy' });
  await post(s, 'q10', 'Read', { file_path: '/a' }, { agent_id: 'nometa' });
  assert.notEqual((await agent(id, 'selfy')).parentId, 'selfy');
  assert.equal((await agent(id, 'nometa')).parentId ?? null, null);
});

test('AC3 a parentAgentId naming an unknown agent leaves no dangling parent id', async () => {
  const s = sid(); const id = await newRun(s);
  meta(s, 'orph', { agentType: 'w', toolUseId: 't', parentAgentId: 'does-not-exist', spawnDepth: 2 });
  await post(s, 'q11', 'Read', { file_path: '/a' }, { agent_id: 'orph' });
  const d = await detail(id);
  const ids = new Set(d.agents.map((a) => a.id));
  const a = d.agents.find((x) => x.id === 'orph');
  assert.ok(a.parentId == null || ids.has(a.parentId), `dangling parent ${a.parentId}`);
});

// ---- activity endpoint
test('AC5 GET /activity: 404 unknown run, 400 missing agent, [] unknown agent', async () => {
  const s = sid(); const id = await newRun(s);
  const r404 = await get('/api/runs/nope-run/activity?agent=a');
  assert.equal(r404.status, 404); assert.ok(r404.json?.error);
  const r400 = await get(`/api/runs/${id}/activity`);
  assert.equal(r400.status, 400); assert.ok(r400.json?.error);
  assert.equal((await get(`/api/runs/${id}/activity?agent=`)).status, 400);
  const ok = await get(`/api/runs/${id}/activity?agent=ghost`);
  assert.equal(ok.status, 200); assert.deepEqual(ok.json, []);
});

test('AC5 GET /activity: only that agent, newest first, default 50, limit up to 200, rows older than the last 100 reachable', async () => {
  const s = sid(); const id = await newRun(s);
  for (let i = 0; i < 150; i++) await post(s, `A${i}`, 'Read', { file_path: `/a${i}` }, { agent_id: 'agA', agent_type: 'w' });
  for (let i = 0; i < 120; i++) await post(s, `B${i}`, 'Read', { file_path: `/b${i}` }, { agent_id: 'agB', agent_type: 'w' });
  const dflt = (await get(`/api/runs/${id}/activity?agent=agA`)).json;
  assert.equal(dflt.length, 50);
  assert.ok(dflt.every((r) => r.agentId === 'agA'));
  const ids = dflt.map((r) => r.id);
  assert.deepEqual(ids, [...ids].sort((x, y) => y - x), 'newest first');
  const all = (await get(`/api/runs/${id}/activity?agent=agA&limit=200`)).json;
  assert.ok(all.length >= 150, `got ${all.length}`);
  assert.ok(all.some((r) => r.toolUseId === 'A0'), 'oldest call reachable');
  assert.ok(!(await detail(id)).activity.some((r) => r.toolUseId === 'A0'), 'sanity: A0 is outside detail.activity');
  const one = (await get(`/api/runs/${id}/activity?agent=agA&limit=1`)).json;
  assert.equal(one.length, 1);
  assert.deepEqual(Object.keys(one[0]).sort(), Object.keys((await detail(id)).activity[0]).sort(), 'same row shape as detail.activity');
});

test('AC5 GET /activity: odd limits never error or exceed 200; agent id is bound, not concatenated', async () => {
  const s = sid(); const id = await newRun(s);
  for (let i = 0; i < 5; i++) await post(s, `C${i}`, 'Read', { file_path: '/c' }, { agent_id: 'agC' });
  for (const l of ['0', '-5', '9999', 'abc', '1e9', '']) {
    const r = await get(`/api/runs/${id}/activity?agent=agC&limit=${l}`);
    assert.equal(r.status, 200, `limit=${l} -> ${r.status}`);
    assert.ok(Array.isArray(r.json) && r.json.length <= 200);
  }
  const inj = await get(`/api/runs/${id}/activity?agent=${encodeURIComponent("agC' OR '1'='1")}`);
  assert.equal(inj.status, 200); assert.deepEqual(inj.json, []);
  const main = await get(`/api/runs/${id}/activity?agent=${encodeURIComponent('main:' + s)}`);
  assert.equal(main.status, 200);
});

test('AC5 GET /activity: includes non-tool events of the agent (every event)', async () => {
  const s = sid(); const id = await newRun(s);
  await H(s, 'SubagentStart', { agent_id: 'agD', agent_type: 'w' });
  await post(s, 'D1', 'Read', { file_path: '/d' }, { agent_id: 'agD' });
  const r = (await get(`/api/runs/${id}/activity?agent=agD`)).json;
  assert.ok(r.some((x) => x.event === 'subagent_start'));
  assert.ok(r.some((x) => x.event === 'tool'));
});

test('AC6 /ledger: a run with a recorded change returns more than a run with none', async () => {
  const s = sid(); const id = await newRun(s);
  const empty = await get(`/api/runs/${id}/ledger`);
  assert.equal(empty.status, 200);
  await post(s, 'L1', 'Bash', { command: 'git push origin main' }, {}, { stdout: '1234567..89abcde main -> main' });
  const full = await get(`/api/runs/${id}/ledger`);
  assert.ok(full.text.length > empty.text.length);
});
