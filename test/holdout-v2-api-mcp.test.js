// Holdout: AC4/AC5/AC6/AC8 through the real server (REST and MCP) plus AC14 regressions in graph form.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient, hook, runIdOf, denied, clone, until } from './holdout-v2-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const lines = (r) => r.text.split('\n');
const gateAgree = (id) => S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'spec' } });
async function startAtSplit(title) {
  const id = runIdOf((await M.call('start_run', { title })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  await gateAgree(id);
  const out = await M.call('complete_stage', { run: id, stage: 'plan', outcome: 'done' });
  return { id, out };
}
const getWorkflow = async () => (await S.api('GET', '/api/workflow')).json;
const putDraft = (workflow) => S.api('PUT', '/api/workflow/draft', { body: { workflow } });

// ---------------- MCP (AC6) ----------------
test('MCP: a parallel result lists every active node with runner, model and instructions', async () => {
  const { out } = await startAtSplit('mcp parallel');
  const l = lines(out);
  assert.match(l[0], /^RUN mcp-parallel · stage implement \(.+\) \+ prep \(.+\) · round 0\/5 · status active$/);
  const next = l.filter((x) => x.startsWith('NEXT: '));
  const instr = l.filter((x) => x.startsWith('INSTRUCTIONS: '));
  assert.equal(next.length, 2);
  assert.equal(instr.length, 2);
  assert.match(next[0], /^NEXT: implement \(.+\) — runner worker, model sonnet$/);
  assert.match(next[1], /^NEXT: prep \(.+\) — runner verifier, model sonnet$/);
  assert.ok(l.indexOf(next[0]) < l.indexOf(instr[0]) && l.indexOf(instr[0]) < l.indexOf(next[1]) && l.indexOf(next[1]) < l.indexOf(instr[1]), 'NEXT/INSTRUCTIONS pairs are in node order');
  assert.ok(l.includes('PARALLEL: run these together, then report each with complete_stage.'));
});

test('MCP: after one branch reports, the result has a single active node and no PARALLEL line', async () => {
  const { id } = await startAtSplit('mcp one left');
  const r = await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'done' });
  const l = lines(r);
  assert.match(l[0], /^RUN mcp-one-left · stage prep \(.+\) · round 0\/5 · status active$/);
  assert.equal(l.filter((x) => x.startsWith('NEXT: ')).length, 1);
  assert.ok(!l.some((x) => x.startsWith('PARALLEL')));
  const last = await M.call('complete_stage', { run: id, stage: 'prep', outcome: 'done' });
  assert.match(lines(last)[0], /^RUN mcp-one-left · stage verify \(.+\) · round 0\/5 · status active$/);
  assert.match(lines(last)[1], /^NEXT: verify \(.+\) — runner verifier, model sonnet$/);
});

test('MCP: get_run gives the same shape as complete_stage', async () => {
  const { id, out } = await startAtSplit('mcp get run');
  assert.equal((await M.call('get_run', { run: id })).text, out.text);
});

test('MCP: waiting, then ended, results', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'mcp wait' })).text);
  const w = await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const l = lines(w);
  assert.match(l[0], /^RUN mcp-wait · stage gate1 \(.+\) · round 0\/5 · status waiting$/);
  assert.equal(l[1], "WAITING ON RYAN: What's your solution?");
  assert.equal(l[2], 'ACTIONS: Agree spec | Stop run (text allowed)');
  assert.match(l[3], /^Run in the background: node ".+" wait mcp-wait$/);
  assert.ok(!l.some((x) => x.startsWith('NEXT')));
  await S.api('POST', `/api/runs/${id}/stop`);
  const ended = await M.call('get_run', { run: id });
  assert.equal(ended.text, `RUN ${id} · stage stopped (Stopped) · round 0/5 · status stopped`);
});

test('MCP: errors are isError with an ERROR: prefix and the engine message', async () => {
  const { id } = await startAtSplit('mcp errors');
  const inactive = await M.call('complete_stage', { run: id, stage: 'verify', outcome: 'pass' });
  assert.equal(inactive.isError, true);
  assert.match(inactive.text, /^ERROR: Stage 'verify' is not active\. Active: /);
  const noEdge = await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'stuck' });
  assert.equal(noEdge.isError, true);
  assert.match(noEdge.text, /^ERROR: No edge from 'implement' for outcome 'stuck'\. Valid outcomes: /);
  const gate = runIdOf((await M.call('start_run', { title: 'mcp gate err' })).text);
  await M.call('complete_stage', { run: gate, stage: 'frame', outcome: 'done' });
  const g = await M.call('complete_stage', { run: gate, stage: 'gate1', outcome: 'pass' });
  assert.equal(g.isError, true);
  assert.match(g.text, /waiting on Ryan at 'gate1'; use respond/);
  assert.equal((await M.call('respond', { run: id, action: 'Agree spec' })).isError, true);
});

test('MCP: respond works through the tool for a waiting gate; unknown label lists the labels', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'mcp respond' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const bad = await M.call('respond', { run: id, action: 'Maybe' });
  assert.equal(bad.isError, true);
  assert.match(bad.text, /Agree spec/);
  const ok = await M.call('respond', { run: id, action: 'Agree spec', text: 'go' });
  assert.match(lines(ok)[0], /stage plan /);
});

test('MCP: get_workflow lists nodes then edges, marks fix-round edges, for the published version and a pinned run', async () => {
  const t = (await M.call('get_workflow')).text;
  assert.match(t.split('\n')[0], /^WORKFLOW v\d+/);
  const l = t.split('\n');
  const firstEdge = l.findIndex((x) => /verify -fail-> fix/.test(x));
  const lastNode = l.map((x, i) => (/prep/.test(x) && !/-> /.test(x) ? i : -1)).filter((i) => i >= 0).at(-1);
  assert.ok(firstEdge > 0, 'edge line for verify -fail-> fix');
  assert.ok(lastNode >= 0 && lastNode < firstEdge, 'nodes come before edges');
  assert.match(l[firstEdge], /\(fix round\)/);
  assert.ok(l.some((x) => /gate2 -Accept-> pr/.test(x)));
  assert.ok(l.some((x) => /split -\*-> implement/.test(x)));
  assert.ok(l.some((x) => /join -\*-> verify/.test(x)));
  assert.ok(!l.some((x) => /verify -pass-> review.*\(fix round\)/.test(x)));
  const { id } = await startAtSplit('mcp wf');
  assert.match((await M.call('get_workflow', { run: id })).text, /^WORKFLOW v1/);
});

// ---------------- REST (AC4, AC5, AC8) ----------------
test('REST: run summary and detail carry the graph fields', async () => {
  const { id } = await startAtSplit('rest detail');
  const list = (await S.api('GET', '/api/runs')).json;
  const row = list.find((r) => r.id === id);
  assert.deepEqual(row.active.map((a) => a.id).sort(), ['implement', 'prep']);
  assert.ok(row.active.every((a) => a.name && a.type === 'step'));
  assert.equal(row.maxRounds, 5);
  const d = (await S.api('GET', `/api/runs/${id}`)).json;
  assert.ok(Array.isArray(d.workflow.nodes) && Array.isArray(d.workflow.edges));
  assert.ok(Array.isArray(d.visits));
  assert.ok(d.visits.some((v) => v.node === 'implement' && v.leftAt === null));
  assert.equal(d.nodes.frame.visits, 1);
  assert.equal(typeof d.durationMs, 'number');
  for (const k of ['run', 'timeline', 'agents', 'activity']) assert.ok(k in d, k);
});

test('REST: a waiting gate offers actions and textField in the summary', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'rest gate' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const r = (await S.api('GET', `/api/runs/${id}`)).json.run;
  assert.deepEqual(r.actions, [{ label: 'Agree spec' }, { label: 'Stop run' }]);
  assert.equal(r.textField, true);
  assert.deepEqual(r.active.map((a) => a.id), ['gate1']);
});

test('REST: draft and publish errors are {message, node?, edge?} objects', async () => {
  const cur = await getWorkflow();
  const w = clone(cur.published.workflow);
  w.nodes.find((n) => n.id === 'frame').name = '';
  const put = await putDraft(w);
  assert.equal(put.status, 200);
  assert.ok(put.json.errors.length > 0);
  assert.ok(put.json.errors.every((e) => typeof e.message === 'string'));
  assert.ok(put.json.errors.some((e) => e.node === 'frame' || e.message.includes('frame')));
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 400);
  assert.ok(pub.json.errors.every((e) => typeof e.message === 'string'));
  assert.deepEqual((await S.api('GET', '/api/workflow')).json.draft.errors.length > 0, true);
  await S.api('DELETE', '/api/workflow/draft');
});

test('REST: a dangling edge is reported against the edge', async () => {
  const w = clone((await getWorkflow()).published.workflow);
  w.edges.push({ id: 'dangling-edge', from: 'frame', to: 'nowhere', on: 'regression' });
  const put = await putDraft(w);
  assert.ok(put.json.errors.some((e) => e.edge === 'dangling-edge' || e.message.includes('dangling-edge') || e.message.includes('nowhere')));
  await S.api('DELETE', '/api/workflow/draft');
});

test('REST: push-rule refusal at publish (gate1 Agree spec -> pr)', async () => {
  const w = clone((await getWorkflow()).published.workflow);
  w.edges = w.edges.map((e) => (e.from === 'gate1' && e.on === 'Agree spec' ? { ...e, to: 'pr' } : e));
  await putDraft(w);
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 400, 'a workflow that can reach pr without gate2 was published');
  assert.ok(pub.json.errors.some((e) => /pr|push/i.test(e.node ?? '') || /pr|push/i.test(e.message)));
  await S.api('DELETE', '/api/workflow/draft');
});

test('REST: oversized graph drafts are refused with 400 and the API keeps working', async () => {
  const nodes = Array.from({ length: 5000 }, (_, i) => ({ id: `n${i}`, type: 'step', name: 'n', runner: 'worker', model: 'inherit', instructions: '', position: { x: 0, y: 0 } }));
  const r = await putDraft({ nodes, edges: [], loop: { maxRounds: 5, decision: 'decision' } });
  assert.equal(r.status, 400);
  const huge = await putDraft({ nodes: Array.from({ length: 200000 }, () => ({})), edges: [], loop: {} }).catch(() => ({ status: 413 }));
  assert.ok(huge.status < 500);
  assert.equal((await S.api('GET', '/api/workflow')).status, 200);
  assert.notEqual((await S.api('POST', '/api/workflow/publish')).status, 500);
  await S.api('DELETE', '/api/workflow/draft');
});

test('REST: publish then start a run: the new run follows the new graph; running runs keep theirs', async () => {
  const old = runIdOf((await M.call('start_run', { title: 'old graph run' })).text);
  const w = clone((await getWorkflow()).published.workflow);
  w.nodes.find((n) => n.id === 'frame').name = 'Framing v2';
  await putDraft(w);
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 200);
  const v = pub.json.version;
  assert.ok(v >= 2);
  assert.equal((await S.api('GET', `/api/runs/${old}`)).json.run.workflowVersion, v - 1);
  const fresh = runIdOf((await M.call('start_run', { title: 'new graph run' })).text);
  const r = (await S.api('GET', `/api/runs/${fresh}`)).json;
  assert.equal(r.run.workflowVersion, v);
  assert.equal(r.run.stageName, 'Framing v2');
  const versions = (await S.api('GET', '/api/workflow/versions')).json;
  assert.equal(versions[0].version, v);
  assert.equal(typeof versions[0].nodes, 'number');
  assert.equal(typeof versions[0].publishedAt, 'string');
  const one = await S.api('GET', `/api/workflow/versions/${v - 1}`);
  assert.equal(one.status, 200);
  assert.ok(Array.isArray(one.json.workflow.nodes));
  const load = await S.api('POST', `/api/workflow/versions/${v - 1}/load`);
  assert.equal(load.status, 200);
  assert.equal(load.json.baseVersion, v - 1);
  assert.equal((await S.api('GET', '/api/workflow/versions/999')).status, 404);
});

test('REST: respond and stop answer with the new summary', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'rest respond' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const bad = await S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'nope' } });
  assert.equal(bad.status, 400);
  const ok = await gateAgree(id);
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stage, 'plan');
  assert.deepEqual(ok.json.active.map((a) => a.id), ['plan']);
});

test('SSE fires when a parallel branch completes', async () => {
  const { id } = await startAtSplit('sse parallel');
  const http = await import('node:http');
  const events = [];
  const rq = http.request({ host: '127.0.0.1', port: S.port, path: '/api/events' }, (res) => res.on('data', (c) => events.push(String(c))));
  rq.end();
  await new Promise((x) => setTimeout(x, 150));
  await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'done' });
  const seen = await until(() => events.join('').includes(`"runId":"${id}"`), 3000);
  rq.destroy();
  assert.ok(seen);
});

// ---------------- AC14 in graph form ----------------
test('wait CLI endpoint: a long poll on a parallel run returns once Ryan answers a later gate', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'wait graph' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const pending = S.api('GET', `/api/runs/${id}/wait?timeout=8000`);
  await new Promise((x) => setTimeout(x, 150));
  await gateAgree(id);
  const w = (await pending).json;
  assert.deepEqual([w.done, w.action, w.stage, w.status], [true, 'Agree spec', 'plan', 'active']);
});

test('Stop in the middle of a parallel pair denies BOTH subagents, and one that starts after the stop', async () => {
  const { id } = await startAtSplit('stop parallel');
  const sid = 'sess-stop-parallel';
  const base = (aid) => ({ session_id: sid, transcript_path: 'x.jsonl', cwd: '.', agent_id: aid, agent_type: 'sonnet-engineer' });
  await hook(S.port, { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id }, tool_response: [{ type: 'text', text: `RUN ${id}` }] });
  const bash = (aid) => hook(S.port, { ...base(aid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `tu-${aid}` });
  await hook(S.port, { ...base('w1'), hook_event_name: 'SubagentStart' });
  await hook(S.port, { ...base('w2'), hook_event_name: 'SubagentStart' });
  assert.equal(denied(await bash('w1')), false);
  assert.equal(denied(await bash('w2')), false);
  const stopped = await S.api('POST', `/api/runs/${id}/stop`);
  assert.equal(stopped.json.status, 'stopped');
  assert.equal(denied(await bash('w1')), true);
  assert.equal(denied(await bash('w2')), true);
  assert.equal(denied(await bash('w3-late')), true);
  assert.equal((await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'done' })).isError, true);
});

test('a subagent cannot approve a gate: respond tool and curl are both refused', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'gate bypass graph' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const sid = 'sess-gate-bypass-graph';
  const base = { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', agent_id: 'a-bypass', agent_type: 'sonnet-engineer' };
  assert.equal(denied(await hook(S.port, { ...base, hook_event_name: 'PreToolUse', tool_name: 'mcp__agent-monitor__respond', tool_input: { run: id, action: 'Agree spec' }, tool_use_id: 't1' })), true);
  const cmd = `curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"Agree spec"}' http://127.0.0.1:${S.port}/api/runs/${id}/respond`;
  assert.equal(denied(await hook(S.port, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 't2' })), true);
  assert.equal((await S.api('GET', `/api/runs/${id}`)).json.run.status, 'waiting');
});

test('hooks still fail open on parallel runs and unknown things', async () => {
  const { id } = await startAtSplit('failopen parallel');
  for (const p of [{}, { hook_event_name: 'PreToolUse' }, { session_id: 's', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: 'no-such-run', stage: 'x' } }, { session_id: 's', agent_id: 'q', hook_event_name: 'SubagentStop' }]) {
    const r = await hook(S.port, p);
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {});
  }
  assert.ok((await S.api('GET', `/api/runs/${id}`)).json.run.active.length === 2);
});

// ---------------- agents: start_nodes / reported_nodes (pinned by the fact sheet) ----------------
test('an agent created while two nodes are active remembers both as start_nodes', async () => {
  const { id } = await startAtSplit('start nodes');
  const sid = 'sess-start-nodes';
  await hook(S.port, { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id }, tool_response: [{ type: 'text', text: `RUN ${id}` }] });
  await hook(S.port, { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', agent_id: 'sn-1', agent_type: 'sonnet-engineer', hook_event_name: 'SubagentStart' });
  const a = S.srv.store.getAgent('sn-1');
  assert.ok(a, 'agent row exists');
  assert.deepEqual(JSON.parse(a.start_nodes).sort(), ['implement', 'prep']);
  await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'done' });
  await hook(S.port, { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', agent_id: 'sn-2', agent_type: 'sonnet-engineer', hook_event_name: 'SubagentStart' });
  assert.deepEqual(JSON.parse(S.srv.store.getAgent('sn-2').start_nodes), ['prep']);
  assert.deepEqual(JSON.parse(S.srv.store.getAgent('sn-1').start_nodes).sort(), ['implement', 'prep'], 'start_nodes does not change afterwards');
});

test('an agent that calls complete_stage gets that stage in reported_nodes', async () => {
  const { id } = await startAtSplit('reported nodes');
  const sid = 'sess-reported';
  await hook(S.port, { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id }, tool_response: [{ type: 'text', text: `RUN ${id}` }] });
  const base = { session_id: sid, transcript_path: 'x.jsonl', cwd: '.', agent_id: 'rn-1', agent_type: 'sonnet-engineer' };
  await hook(S.port, { ...base, hook_event_name: 'SubagentStart' });
  await hook(S.port, { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: id, stage: 'implement', outcome: 'done' }, tool_response: [{ type: 'text', text: `RUN ${id}` }] });
  const a = S.srv.store.getAgent('rn-1');
  assert.deepEqual(JSON.parse(a.reported_nodes), ['implement']);
});
