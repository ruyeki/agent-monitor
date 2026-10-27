// Holdout (phase B, AC9/AC11/AC12 on the server): run detail tokens from the attribution, GET /api/stats/versions and the versions stats.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { boot, mcpClient, runIdOf, until, hook, tline, writeLines, appendLines, mainFile, subFile, tokTotal } from './holdout-v2-helpers.js';

const PROJ = fs.mkdtempSync(path.join(os.tmpdir(), 'am-proj-'));
let S; let M;
before(async () => { S = await boot({ projects: PROJ }); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch { /* ignore */ } await S?.srv.close(); });

const call = async (name, args) => (await M.call(name, args)).text;
const detail = async (id) => (await S.api('GET', `/api/runs/${id}`)).json;
const link = (session, runId) => hook(S.port, {
  hook_event_name: 'PostToolUse', session_id: session, transcript_path: mainFile(PROJ, session), cwd: '/x',
  tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: runId },
  tool_response: { content: [{ type: 'text', text: `RUN ${runId} · stage frame (Frame) · round 0/5 · status active` }] },
});
const pre = (session, extra = {}) => hook(S.port, {
  hook_event_name: 'PreToolUse', session_id: session, transcript_path: mainFile(PROJ, session), cwd: '/x',
  tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-' + Math.random(), ...extra,
});
async function finish(run) {
  const step = (stage, outcome = 'done') => call('complete_stage', { run, stage, outcome });
  await step('frame');
  await S.api('POST', `/api/runs/${run}/respond`, { body: { action: 'Agree spec', text: 'x' } });
  await step('plan'); await step('implement'); await step('prep');
  await step('verify', 'pass'); await step('review', 'pass'); await step('whitehat', 'pass');
  await step('commit'); await step('report');
  await S.api('POST', `/api/runs/${run}/respond`, { body: { action: 'Accept', text: 'y' } });
  await step('pr');
  assert.equal((await detail(run)).run.status, 'done');
}

let A; const SESSION = 'sess-run-a';
test('AC9 run detail: node/run/agent tokens come from the indexer attribution (max per message, main kept apart)', async () => {
  A = runIdOf(await call('start_run', { title: 'Attribution run' }));
  await link(SESSION, A);
  await pre(SESSION); // the main:<session> agent row
  await pre(SESSION, { agent_id: 'ag1', agent_type: 'sonnet-engineer' });
  await hook(S.port, { hook_event_name: 'PostToolUse', session_id: SESSION, agent_id: 'ag1', agent_type: 'sonnet-engineer', transcript_path: mainFile(PROJ, SESSION), cwd: '/x',
    tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: A, stage: 'frame', outcome: 'done' }, tool_response: { content: [{ type: 'text', text: 'RUN ok' }] } });
  const ts = new Date().toISOString();
  // message ids repeat with a growing output count; the indexer keeps the maximum, the old per-agent totals kept the first line
  writeLines(mainFile(PROJ, SESSION), [
    tline({ id: 'mm1', ts, session: SESSION, model: 'claude-opus-5-5-20261001', input: 100, output: 10, cacheRead: 1000 }),
    tline({ id: 'mm1', ts, session: SESSION, model: 'claude-opus-5-5-20261001', input: 100, output: 50, cacheRead: 1000 }),
    tline({ id: 'oo1', ts, session: 'someone-else', model: 'claude-opus-5-5-20261001', input: 7777, output: 1 }),
  ]);
  writeLines(subFile(PROJ, SESSION, 'ag1'), [
    tline({ id: 'ss1', ts, session: SESSION, agent: 'ag1', input: 200, output: 5, cacheWrite: 300, cacheWrite1h: 100 }),
    tline({ id: 'ss1', ts, session: SESSION, agent: 'ag1', input: 200, output: 60, cacheWrite: 300, cacheWrite1h: 100 }),
  ]);
  // the subagent and main-session files are indexed independently, so wait for both final figures
  const d = await until(async () => { const x = await detail(A); return x.agents.find((a) => a.id === 'ag1')?.tokens?.output === 60 && x.tokens?.main?.output === 50 ? x : null; }, 15000, 150);
  assert.ok(d, 'run detail did not show the indexer numbers (subagent output 60, main output 50) within 15 s');
  const sub = d.agents.find((a) => a.id === 'ag1');
  for (const f of ['input', 'output', 'cacheWrite', 'cacheRead', 'total', 'cost']) assert.equal(typeof sub.tokens[f], 'number', f);
  assert.deepEqual([sub.tokens.input, sub.tokens.output, sub.tokens.cacheWrite, sub.tokens.cacheRead, sub.tokens.total], [200, 60, 300, 0, 560]);
  // run level
  for (const k of ['nodes', 'main', 'unattributed', 'total']) assert.ok(k in d.tokens, k);
  assert.deepEqual([d.tokens.main.input, d.tokens.main.output, d.tokens.main.cacheRead], [100, 50, 1000], 'main session: only this run\'s session, final output count');
  assert.equal(d.nodes.frame.tokens.total, 560, 'the single-report subagent lands on the node it reported');
  assert.equal(d.tokens.nodes.frame.total, 560);
  assert.equal(d.tokens.total.total, d.tokens.main.total + d.tokens.unattributed.total + Object.values(d.tokens.nodes).reduce((a, t) => a + t.total, 0));
  assert.equal(d.tokens.total.input, 300, 'the other session (7777) is not part of the run');
  assert.ok(d.tokens.total.cost > 0, 'priced model gives a cost');
  const mainRow = d.agents.find((a) => a.id === `main:${SESSION}`);
  assert.equal(mainRow.tokens.total, d.tokens.main.total, 'the main:<sid> row shows the run-level main figure');
  for (const id of Object.keys(d.workflow.nodes.reduce((o, n) => ({ ...o, [n.id]: 1 }), {}))) assert.equal(typeof d.nodes[id].tokens?.total, 'number', `node ${id} carries tokens`);
});

test('AC9 run detail keeps its old fields (visits, durations) next to the new tokens', async () => {
  const d = await detail(A);
  assert.ok(Array.isArray(d.visits) && d.visits.length >= 1);
  assert.equal(typeof d.durationMs, 'number');
  assert.equal(typeof d.nodes.frame.durationMs, 'number');
});

test('AC9 a run without any transcript has zero tokens everywhere (and the endpoint does not fail)', async () => {
  const id = runIdOf(await call('start_run', { title: 'No tokens' }));
  const d = await detail(id);
  assert.equal(d.tokens.total.total, 0);
  assert.equal(d.nodes.frame.tokens.total, 0);
});

test('AC10 the server announces new usage over SSE as {type:"usage"}', async () => {
  const ctl = new AbortController();
  const res = await fetch(`${S.url.replace(/\/$/, '')}/api/events`, { signal: ctl.signal });
  const reader = res.body.getReader();
  let text = '';
  const seen = (async () => { const dec = new TextDecoder(); for (;;) { const { value, done } = await reader.read(); if (done) return false; text += dec.decode(value); if (/"type"\s*:\s*"usage"/.test(text)) return true; } })();
  appendLines(mainFile(PROJ, SESSION), [tline({ id: 'sse1', ts: new Date().toISOString(), session: SESSION, input: 1, output: 1 })]);
  const got = await Promise.race([seen, new Promise((r) => setTimeout(() => r(false), 12000))]);
  ctl.abort();
  assert.equal(got, true, 'no usage event after new transcript data');
});

test('AC11 /api/stats/versions: newest first, finished runs only, avg tokens and duration, per-node averages', async () => {
  const B = runIdOf(await call('start_run', { title: 'Finished B' }));
  const C = runIdOf(await call('start_run', { title: 'Stopped C' }));
  await call('start_run', { title: 'Active D' });
  await S.api('POST', `/api/runs/${C}/stop`);
  await finish(A);
  await finish(B);
  const da = await detail(A); const db = await detail(B);
  const v0 = (await S.api('GET', '/api/stats/versions')).json;
  assert.ok(Array.isArray(v0) && v0.length >= 1);
  const cur = v0[0];
  for (const k of ['version', 'publishedAt', 'finishedRuns', 'avgTokens', 'avgDurationMs', 'nodes']) assert.ok(k in cur, k);
  assert.equal(cur.finishedRuns, 2, 'the stopped and the active run are not finished runs');
  assert.ok(Math.abs(cur.avgTokens - (da.tokens.total.total + db.tokens.total.total) / 2) <= 1);
  assert.ok(da.tokens.total.total > 0 && db.tokens.total.total === 0, 'fixture has a real mean, not 0/0');
  assert.ok(Math.abs(cur.avgDurationMs - (da.durationMs + db.durationMs) / 2) <= 1, `duration ${cur.avgDurationMs} vs ${(da.durationMs + db.durationMs) / 2}`);
  const node = (id) => cur.nodes.find((x) => x.id === id);
  for (const id of ['frame', 'plan', 'implement', 'prep', 'verify']) {
    assert.equal(node(id).runs, 2, id);
    assert.equal(typeof node(id).name, 'string');
    const want = (da.nodes[id].durationMs + db.nodes[id].durationMs) / 2;
    assert.ok(Math.abs(node(id).avgDurationMs - want) <= 1, `${id} duration`);
    assert.ok(Math.abs(node(id).avgTokens - (da.nodes[id].tokens.total + db.nodes[id].tokens.total) / 2) <= 1, `${id} tokens`);
  }
  assert.ok(!node('fix') || node('fix').runs === 0, 'a node no finished run visited has no runs');
  const wv = (await S.api('GET', '/api/workflow/versions')).json;
  const row = wv.find((x) => x.version === cur.version);
  assert.deepEqual([row.stats.finishedRuns, row.stats.avgTokens, row.stats.avgDurationMs], [cur.finishedRuns, cur.avgTokens, cur.avgDurationMs], 'versions list carries the same stats');
});

test('AC11 a newly published version starts with no finished runs and the older one keeps its stats (newest first)', async () => {
  const before = (await S.api('GET', '/api/stats/versions')).json;
  const draft = (await S.api('GET', '/api/workflow')).json.draft.workflow;
  draft.nodes.find((x) => x.id === 'frame').name = 'Frame it';
  assert.equal((await S.api('PUT', '/api/workflow/draft', { body: { workflow: draft } })).status, 200);
  assert.equal((await S.api('POST', '/api/workflow/publish')).status, 200);
  const after2 = (await S.api('GET', '/api/stats/versions')).json;
  assert.equal(after2.length, before.length + 1);
  assert.ok(after2[0].version > after2[1].version, 'newest first');
  assert.equal(after2[0].finishedRuns, 0);
  assert.ok(!after2[0].avgTokens, 'no runs: average is 0 or null, never NaN');
  assert.equal(after2[1].finishedRuns, 2);
  assert.equal(JSON.stringify(after2).includes('NaN'), false);
  const wv = (await S.api('GET', '/api/workflow/versions')).json;
  assert.equal(wv.find((x) => x.version === after2[0].version).stats.finishedRuns, 0);
});

test('AC11 the stats endpoints are GET-only reads and refuse a foreign Host', async () => {
  assert.equal((await S.api('GET', '/api/stats/versions', { headers: { Host: 'evil.example:80' } })).status, 403);
  assert.equal((await S.api('GET', '/api/stats/usage', { headers: { Host: 'evil.example:80' } })).status, 403);
  assert.equal((await S.api('GET', '/api/prices', { headers: { Host: 'evil.example:80' } })).status, 403);
  assert.notEqual((await S.api('POST', '/api/stats/usage')).status, 200);
});
