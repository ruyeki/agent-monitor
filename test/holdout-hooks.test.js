import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, mcpClient, req, until, runIdOf, tmp, sleep } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const hook = (payload) => req(S.port, 'POST', '/hook', { body: payload });
const detail = async (id) => (await S.api('GET', `/api/runs/${id}`)).json;
const agents = async (id) => (await detail(id)).agents;
const agentOf = async (id, aid) => (await agents(id)).find((a) => a.id === aid);
// The hooks' own (v1) running counts in the agents table; the REST agent.tokens now comes from the usage indexer.
const v1Tokens = (aid) => { const a = S.srv.store.getAgent(aid); return a && { input: a.input_tokens, output: a.output_tokens, cacheCreation: a.cache_creation_tokens, cacheRead: a.cache_read_tokens }; };
let n = 0;
const sid = () => `sess-${++n}-${Math.random().toString(16).slice(2, 8)}`;
const newRun = async (title) => runIdOf((await M.call('start_run', { title })).text);
const tp = (session) => path.join(S.projects, 'proj', `${session}.jsonl`);
const linkViaStartRun = async (session, runId, extra = {}) => hook({
  hook_event_name: 'PostToolUse', session_id: session, transcript_path: tp(session), cwd: '/x',
  tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: runId },
  tool_response: { content: [{ type: 'text', text: `RUN ${runId} · stage frame (Frame) · round 0/5 · status active` }] }, ...extra,
});
const pre = (session, extra = {}) => hook({
  hook_event_name: 'PreToolUse', session_id: session, transcript_path: tp(session), cwd: '/x',
  tool_name: 'Bash', tool_input: { command: 'echo hi' }, tool_use_id: 'tu-' + Math.random(), ...extra,
});

// ---- AC8
test('AC8 hook always answers 200 {} fast, even for events that store nothing', async () => {
  const t0 = Date.now();
  const r = await hook({ hook_event_name: 'Stop', session_id: sid(), transcript_path: '/nope.jsonl' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {});
  assert.ok(Date.now() - t0 < 500);
});

test('AC8 malformed or odd bodies -> 200 {}', async () => {
  for (const raw of ['not json{', '', '[]', 'null', '"str"', '{"hook_event_name": 5}', '{"hook_event_name":"PreToolUse"}', '{"hook_event_name":"Bogus","session_id":"s"}']) {
    const r = await req(S.port, 'POST', '/hook', { rawBody: raw, headers: { 'Content-Type': 'application/json' } });
    assert.equal(r.status, 200, JSON.stringify(raw));
    assert.deepEqual(r.json, {}, JSON.stringify(raw));
  }
  assert.equal((await S.api('GET', '/api/runs')).status, 200, 'server still healthy');
});

test('AC8 start_run PostToolUse links the session; session events become main:<session> agent', async () => {
  const id = await newRun('Link main');
  const session = sid();
  assert.deepEqual((await linkViaStartRun(session, id)).json, {});
  await pre(session, { tool_input: { command: 'git status' } });
  const a = await until(() => agentOf(id, `main:${session}`));
  assert.ok(a, 'main agent row exists');
  assert.equal(a.type, 'main');
  assert.equal((await until(async () => (await agentOf(id, `main:${session}`)).toolCalls >= 1)), true);
  const b = await agentOf(id, `main:${session}`);
  assert.equal(b.lastTool, 'Bash');
  assert.equal(b.lastSummary, 'git status');
  assert.equal(b.toolCalls, 1);
});

test('AC8 tool summary: file_path, pattern, description, url, first string, one line, <=120 chars', async () => {
  const id = await newRun('Summaries');
  const session = sid();
  await linkViaStartRun(session, id);
  const cases = [
    [{ tool_name: 'Read', tool_input: { file_path: 'C:/a/b.txt' } }, (s) => s.includes('C:/a/b.txt')],
    [{ tool_name: 'Grep', tool_input: { pattern: 'needle.*x' } }, (s) => s.includes('needle')],
    [{ tool_name: 'Agent', tool_input: { description: 'Do the thing', prompt: 'long prompt' } }, (s) => s.includes('Do the thing')],
    [{ tool_name: 'WebFetch', tool_input: { url: 'https://example.com/x' } }, (s) => s.includes('example.com')],
    [{ tool_name: 'Bash', tool_input: { command: 'line one\nline two\n' + 'x'.repeat(400) } }, (s) => s.length <= 120 && !s.includes('\n')],
  ];
  for (const [p, check] of cases) {
    await pre(session, p);
    const ok = await until(async () => { const a = await agentOf(id, `main:${session}`); return a?.lastTool === p.tool_name && check(a.lastSummary); });
    assert.ok(ok, 'summary for ' + p.tool_name + ': ' + (await agentOf(id, `main:${session}`))?.lastSummary);
  }
});

test('AC8 agent_id on start_run PostToolUse links that agent to the run (not the session)', async () => {
  const id = await newRun('Link agent');
  const session = sid();
  await linkViaStartRun(session, id, { agent_id: 'agentA1', agent_type: 'sonnet-engineer' });
  const a = await until(() => agentOf(id, 'agentA1'));
  assert.ok(a, 'agent linked');
  await pre(session, { agent_id: 'agentA1', agent_type: 'sonnet-engineer', tool_name: 'Edit', tool_input: { file_path: 'f.js' } });
  const ok = await until(async () => (await agentOf(id, 'agentA1')).toolCalls === 1);
  assert.ok(ok);
  assert.equal((await agentOf(id, 'agentA1')).lastTool, 'Edit');
});

test('AC8 link by complete_stage tool_input.run (non-start_run mcp tool)', async () => {
  const id = await newRun('Link via complete');
  const session = sid();
  await hook({ hook_event_name: 'PostToolUse', session_id: session, transcript_path: tp(session), tool_name: 'mcp__agent-monitor__complete_stage',
    tool_input: { run: id, stage: 'frame', outcome: 'pass' }, tool_response: { content: [{ type: 'text', text: 'whatever' }] } });
  await pre(session);
  assert.ok(await until(() => agentOf(id, `main:${session}`)));
});

test('AC8 SubagentStart in a linked session joins the most recently active non-ended run', async () => {
  const old = await newRun('Join old');
  const recent = await newRun('Join recent');
  const session = sid();
  await linkViaStartRun(session, old);
  await sleep(1100);
  await linkViaStartRun(session, recent);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, transcript_path: tp(session), agent_id: 'subB1', agent_type: 'sonnet-engineer' });
  const a = await until(() => agentOf(recent, 'subB1'));
  assert.ok(a, 'sub agent joined the most recent run');
  assert.equal(a.type, 'sonnet-engineer');
  assert.equal(a.status, 'running');
  assert.ok(!(await agentOf(old, 'subB1')));
});

test('AC8 an unknown agent_id event in a linked session also joins', async () => {
  const id = await newRun('Join unknown');
  const session = sid();
  await linkViaStartRun(session, id);
  await pre(session, { agent_id: 'ghostC1', agent_type: 'Explore' });
  assert.ok(await until(() => agentOf(id, 'ghostC1')));
});

test('AC8 a session that was never linked is dropped', async () => {
  const id = await newRun('Unlinked bystander');
  const stranger = sid();
  await pre(stranger);
  await hook({ hook_event_name: 'SubagentStart', session_id: stranger, agent_id: 'strayD1', agent_type: 'x' });
  await hook({ hook_event_name: 'Notification', session_id: stranger, message: 'hello', notification_type: 'idle_prompt' });
  await sleep(500);
  const all = (await S.api('GET', '/api/runs')).json;
  for (const r of all) {
    const ag = await agents(r.id);
    assert.ok(!ag.some((a) => a.id === 'strayD1' || a.id === `main:${stranger}`), 'run ' + r.id + ' has no stray agent');
  }
  assert.ok(id);
});

test('AC8 a stopped run is still joined by later subagents (they are then denied, AC10)', async () => {
  const id = await newRun('Ended not joined');
  const session = sid();
  await linkViaStartRun(session, id);
  await S.api('POST', `/api/runs/${id}/stop`, { body: {} });
  await hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'lateE1', agent_type: 'x' });
  await sleep(400);
  assert.ok(await agentOf(id, 'lateE1'));
});

test('AC8 failure, permission request and clearing', async () => {
  const id = await newRun('Failure and permission');
  const session = sid();
  await linkViaStartRun(session, id, { agent_id: 'agentF1', agent_type: 'x' });
  await pre(session, { agent_id: 'agentF1', tool_name: 'Bash', tool_input: { command: 'boom' }, tool_use_id: 'tuF1' });
  await hook({ hook_event_name: 'PostToolUseFailure', session_id: session, agent_id: 'agentF1', tool_name: 'Bash', tool_input: { command: 'boom' }, tool_use_id: 'tuF1', error: 'exit 1 bad thing', is_interrupt: false });
  assert.ok(await until(async () => (await agentOf(id, 'agentF1')).errors === 1));
  const a = await agentOf(id, 'agentF1');
  assert.ok(String(a.lastError).includes('bad thing'));
  await hook({ hook_event_name: 'PermissionRequest', session_id: session, agent_id: 'agentF1', tool_name: 'Bash', tool_input: { command: 'rm x' } });
  assert.ok(await until(async () => (await agentOf(id, 'agentF1')).waitingPermission === true));
  await hook({ hook_event_name: 'PostToolUse', session_id: session, agent_id: 'agentF1', tool_name: 'Bash', tool_input: { command: 'rm x' }, tool_response: {}, tool_use_id: 'tuF2' });
  assert.ok(await until(async () => (await agentOf(id, 'agentF1')).waitingPermission === false));
});

test('AC8 PermissionRequest without agent_id matches the pending subagent call by tool and input', async () => {
  const id = await newRun('Permission match');
  const session = sid();
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'agentG1', agent_type: 'x' });
  await pre(session, { agent_id: 'agentG1', tool_name: 'Write', tool_input: { file_path: 'a.txt', content: 'c' }, tool_use_id: 'tuG1' });
  await hook({ hook_event_name: 'PermissionRequest', session_id: session, tool_name: 'Write', tool_input: { content: 'c', file_path: 'a.txt' } });
  assert.ok(await until(async () => (await agentOf(id, 'agentG1')).waitingPermission === true), 'subagent flagged');
  const main = await agentOf(id, `main:${session}`);
  assert.ok(!main || main.waitingPermission !== true, 'main not flagged');
});

test('AC8 SubagentStop marks finished with last_message capped at 300 chars; activity recorded', async () => {
  const id = await newRun('Subagent stop');
  const session = sid();
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'agentH1', agent_type: 'sonnet-engineer' });
  await pre(session, { agent_id: 'agentH1' });
  await hook({ hook_event_name: 'SubagentStop', session_id: session, agent_id: 'agentH1', agent_type: 'sonnet-engineer', last_assistant_message: 'Z'.repeat(1000) });
  assert.ok(await until(async () => (await agentOf(id, 'agentH1')).status === 'finished'));
  const a = await agentOf(id, 'agentH1');
  assert.ok(a.finishedAt);
  assert.ok(a.lastMessage === undefined || String(a.lastMessage).length <= 300);
  const d = await detail(id);
  assert.ok(d.activity.length >= 1);
  assert.ok(d.activity.length <= 100);
});

test('AC8 activity is capped (newest 100 returned) under a flood', async () => {
  const id = await newRun('Flood');
  const session = sid();
  await linkViaStartRun(session, id);
  for (let i = 0; i < 130; i++) await pre(session, { tool_input: { command: 'cmd ' + i } });
  await until(async () => (await agentOf(id, `main:${session}`))?.toolCalls >= 130, 8000);
  const d = await detail(id);
  assert.ok(d.activity.length <= 100);
  assert.ok(d.activity.some((x) => String(x.summary).includes('cmd 129')));
});

// ---- AC10
test('AC10 stop denies subagent PreToolUse with the exact reason; allows agent-monitor tools; never denies main', async () => {
  const id = await newRun('Stop deny');
  const session = sid();
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'agentI1', agent_type: 'x' });
  const before = await pre(session, { agent_id: 'agentI1', agent_type: 'x' });
  assert.deepEqual(before.json, {}, 'running run: no deny');
  await until(() => agentOf(id, 'agentI1'));
  const stop = await S.api('POST', `/api/runs/${id}/stop`, { body: {} });
  assert.equal(stop.json.status, 'stopped');
  const denied = await pre(session, { agent_id: 'agentI1', agent_type: 'x', tool_name: 'Bash' });
  assert.equal(denied.status, 200);
  assert.deepEqual(denied.json, { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Agent Monitor: run ${id} was stopped by Ryan. Stop work and report back.` } });
  for (const tool of ['Edit', 'Read', 'mcp__github__create_pull_request']) {
    const d = await pre(session, { agent_id: 'agentI1', tool_name: tool });
    assert.equal(d.json.hookSpecificOutput?.permissionDecision, 'deny', tool);
  }
  for (const tool of ['mcp__agent-monitor__get_run', 'mcp__agent-monitor__log', 'mcp__agent-monitor__start_run']) {
    const a = await pre(session, { agent_id: 'agentI1', tool_name: tool, tool_input: { run: id } });
    assert.deepEqual(a.json, {}, tool + ' must be allowed');
  }
  const main = await pre(session, { tool_name: 'Bash' });
  assert.deepEqual(main.json, {}, 'main session never denied');
  const mainWithType = await pre(session, { tool_name: 'Bash', agent_type: undefined });
  assert.deepEqual(mainWithType.json, {});
});

test('AC10 non-PreToolUse events are never denied even for a stopped run', async () => {
  const id = await newRun('Stop deny other events');
  const session = sid();
  await linkViaStartRun(session, id, { agent_id: 'agentJ1' });
  await S.api('POST', `/api/runs/${id}/stop`, { body: {} });
  const r = await hook({ hook_event_name: 'PostToolUse', session_id: session, agent_id: 'agentJ1', tool_name: 'Bash', tool_input: {}, tool_response: {} });
  assert.deepEqual(r.json, {});
});

test('AC10 an agent of another, still running run is not denied', async () => {
  const stopped = await newRun('Stop one');
  const live = await newRun('Stop other live');
  const s1 = sid(); const s2 = sid();
  await linkViaStartRun(s1, stopped, { agent_id: 'agentK1' });
  await linkViaStartRun(s2, live, { agent_id: 'agentK2' });
  await S.api('POST', `/api/runs/${stopped}/stop`, { body: {} });
  assert.deepEqual((await pre(s2, { agent_id: 'agentK2' })).json, {});
  assert.equal((await pre(s1, { agent_id: 'agentK1' })).json.hookSpecificOutput?.permissionDecision, 'deny');
});

test('AC10 subagent in a stopped session with an unlinked agent_id still resolves via the session link', async () => {
  const id = await newRun('Stop deny session link');
  const session = sid();
  await linkViaStartRun(session, id);
  await S.api('POST', `/api/runs/${id}/stop`, { body: {} });
  const r = await pre(session, { agent_id: 'unseenL1', agent_type: 'x' });
  // not required to deny (session link of an ended run may be ignored), but must be valid JSON and 200
  assert.equal(r.status, 200);
  assert.ok(r.json && typeof r.json === 'object');
});

// ---- AC9
const asst = (msgId, usage, model = 'claude-sonnet-5-5', block = 'a') => JSON.stringify({
  type: 'assistant', message: { id: msgId, model, role: 'assistant', content: [{ type: 'text', text: 'T-' + block }], usage },
}) + '\n';
const U = (i, o, cc, cr) => ({ input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr });

test('AC9 subagent tokens: dedupe by message.id, incremental reads, partial last line, meta sidecar', async () => {
  const id = await newRun('Tokens');
  const session = sid();
  const main = tp(session);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, '');
  const subDir = path.join(main.replace(/\.jsonl$/, ''), 'subagents');
  fs.mkdirSync(subDir, { recursive: true });
  const aid = 'a0123456789abcdef';
  const file = path.join(subDir, `agent-${aid}.jsonl`);
  fs.writeFileSync(path.join(subDir, `agent-${aid}.meta.json`), JSON.stringify({ agentType: 'sonnet-engineer', description: 'Implement the thing', model: 'claude-sonnet-5-5' }));
  const m1 = U(10, 20, 5, 7); const m2 = U(100, 200, 50, 70); const m3 = U(1000, 2000, 500, 700);
  // m1 appears twice (one line per content block, same usage), then half of m2
  const m2line = asst('msg_2', m2);
  fs.writeFileSync(file, asst('msg_1', m1, undefined, 'a') + asst('msg_1', m1, undefined, 'b') + m2line.slice(0, 40));
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, transcript_path: main, agent_id: aid, agent_type: 'sonnet-engineer' });
  await hook({ hook_event_name: 'PostToolUse', session_id: session, transcript_path: main, agent_id: aid, agent_type: 'sonnet-engineer', tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: {} });
  await sleep(600);
  let a = await agentOf(id, aid);
  assert.ok(a, 'agent exists');
  let t = v1Tokens(aid);
  assert.ok([0, 10].includes(t.input), 'partial line must not be counted; input=' + t.input);
  assert.ok(t.input === 0 || (t.output === 20 && t.cacheCreation === 5 && t.cacheRead === 7), 'm1 counted once');
  // finish the partial line, add m3 (twice) and a synthetic message
  fs.appendFileSync(file, m2line.slice(40) + asst('msg_3', m3, undefined, 'a') + asst('msg_3', m3, undefined, 'b') + asst('msg_syn', U(0, 0, 0, 0), '<synthetic>'));
  await hook({ hook_event_name: 'SubagentStop', session_id: session, transcript_path: main, agent_id: aid, agent_type: 'sonnet-engineer', last_assistant_message: 'done' });
  const ok = await until(async () => { const x = await agentOf(id, aid); return x.status === 'finished' && v1Tokens(aid).input >= 1110; }, 5000);
  a = await agentOf(id, aid);
  assert.ok(ok, 'final read happened: ' + JSON.stringify(v1Tokens(aid)));
  assert.deepEqual(v1Tokens(aid), { input: 1110, output: 2220, cacheCreation: 555, cacheRead: 777 });
  assert.equal(a.model, 'claude-sonnet-5-5', 'model is never <synthetic>');
  assert.equal(a.description, 'Implement the thing');
  // a repeated SubagentStop does not double count
  await hook({ hook_event_name: 'SubagentStop', session_id: session, transcript_path: main, agent_id: aid, last_assistant_message: 'done again' });
  await sleep(500);
  assert.deepEqual(v1Tokens(aid), { input: 1110, output: 2220, cacheCreation: 555, cacheRead: 777 });
});

test('AC9 explicit agent_transcript_path is used and agent- prefix is not doubled', async () => {
  const id = await newRun('Tokens explicit path');
  const session = sid();
  const main = tp(session);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  const custom = path.join(S.projects, 'proj', 'custom-sub.jsonl');
  fs.writeFileSync(custom, asst('msg_x', U(3, 4, 5, 6)));
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, transcript_path: main, agent_id: 'agent-zz9', agent_type: 'x' });
  await hook({ hook_event_name: 'SubagentStop', session_id: session, transcript_path: main, agent_id: 'agent-zz9', agent_transcript_path: custom, last_assistant_message: 'ok' });
  assert.ok(await until(async () => v1Tokens('agent-zz9').input === 3, 5000));
  assert.deepEqual(v1Tokens('agent-zz9'), { input: 3, output: 4, cacheCreation: 5, cacheRead: 6 });
});

test('AC9 transcript paths outside projectsDir or not .jsonl are never read', async () => {
  const id = await newRun('Tokens confined');
  const session = sid();
  const main = tp(session);
  const outside = path.join(tmp('am-outside-'), 'evil.jsonl');
  fs.writeFileSync(outside, asst('msg_o', U(999, 999, 999, 999)));
  const notJsonl = path.join(S.projects, 'proj', 'data.txt');
  fs.mkdirSync(path.dirname(notJsonl), { recursive: true });
  fs.writeFileSync(notJsonl, asst('msg_t', U(888, 888, 888, 888)));
  await linkViaStartRun(session, id);
  for (const [aid, p] of [['outA', outside], ['txtB', notJsonl], ['travC', path.join(S.projects, '..', path.basename(path.dirname(outside)), 'evil.jsonl')]]) {
    await hook({ hook_event_name: 'SubagentStart', session_id: session, transcript_path: main, agent_id: aid, agent_type: 'x' });
    await hook({ hook_event_name: 'SubagentStop', session_id: session, transcript_path: main, agent_id: aid, agent_transcript_path: p, last_assistant_message: 'x' });
  }
  await hook({ hook_event_name: 'SubagentStop', session_id: session, transcript_path: path.join(path.dirname(outside), 'evil.jsonl'), agent_id: 'outD', last_assistant_message: 'x' });
  await sleep(800);
  for (const a of await agents(id)) {
    assert.ok(a.tokens.input < 800, `${a.id} must not have read forbidden files (input ${a.tokens.input})`);
  }
});

test('AC9 agent fields have the documented shape', async () => {
  const id = await newRun('Agent shape');
  const session = sid();
  await linkViaStartRun(session, id);
  await hook({ hook_event_name: 'SubagentStart', session_id: session, agent_id: 'shapeM1', agent_type: 'opus-engineer' });
  const a = await until(() => agentOf(id, 'shapeM1'));
  for (const k of ['id', 'type', 'model', 'description', 'status', 'lastTool', 'lastSummary', 'lastActivityAt', 'toolCalls', 'errors', 'lastError', 'waitingPermission', 'tokens', 'startedAt', 'finishedAt']) assert.ok(k in a, k);
  assert.deepEqual(Object.keys(a.tokens).sort(), ['cacheRead', 'cacheWrite', 'cost', 'input', 'output', 'total', 'unpriced']);
  assert.equal(a.toolCalls, 0);
  assert.equal(a.errors, 0);
  assert.equal(a.waitingPermission, false);
  assert.equal(a.finishedAt, null);
});

test('AC9 main session tokens start at the transcript size when linked (earlier history is not counted)', async () => {
  const id = await newRun('Main tokens');
  const session = sid();
  const main = tp(session);
  fs.mkdirSync(path.dirname(main), { recursive: true });
  fs.writeFileSync(main, asst('hist_1', U(5000, 5000, 5000, 5000)));
  await linkViaStartRun(session, id);
  fs.appendFileSync(main, asst('new_1', U(11, 22, 33, 44)));
  await pre(session);
  await sleep(5200); // token reads are throttled to one per 5 s per agent
  await hook({ hook_event_name: 'PostToolUse', session_id: session, transcript_path: main, tool_name: 'Bash', tool_input: { command: 'x' }, tool_response: {} });
  await hook({ hook_event_name: 'Stop', session_id: session, transcript_path: main });
  const ok = await until(async () => v1Tokens(`main:${session}`)?.input >= 11, 6000);
  assert.ok(ok, 'main tokens were read: ' + JSON.stringify(v1Tokens(`main:${session}`)));
  assert.deepEqual(v1Tokens(`main:${session}`), { input: 11, output: 22, cacheCreation: 33, cacheRead: 44 });
});
