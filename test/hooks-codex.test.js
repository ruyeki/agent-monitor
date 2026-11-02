import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './codex-helpers.js';

const MCP = 'mcp__agent-monitor__';
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;

function setup() {
  const store = openStore(tmp());
  const limits = [];
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.parse('2026-11-02T10:00:00Z'), onLimit: (i) => limits.push(i) });
  const claude = (hook_event_name, extra = {}) => hooks.handle({ session_id: 'cs', cwd: 'C:\\w\\repo', hook_event_name, ...extra });
  const codex = (hook_event_name, extra = {}) => hooks.handle({ session_id: 'thr', hook_event_name, ...extra }, 'codex');
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  return { store, hooks, limits, claude, codex, id: run.id };
}
const handOver = (t, thread = 'thr') => {
  t.store.markLimit(t.id, { at: new Date().toISOString(), source: 'stopfailure' });
  t.store.handOver(t.id);
  t.store.setCodexThread(t.id, thread);
};

test('StopFailure rate_limit on a live run triggers one limit callback with the reset time', () => {
  const t = setup();
  t.claude('StopFailure', { error: 'rate_limit', error_details: { resetsAt: 1791655200 } });
  assert.deepEqual(t.limits, [{ runId: t.id, at: '2026-11-02T10:00:00.000Z', resetsAt: new Date(1791655200 * 1000).toISOString(), source: 'stopfailure' }]);
  assert.equal(t.store.detail(t.id).activity[0].event, 'stop_failure');
});

test('StopFailure: reset time may be an ISO string or missing; other errors only leave an activity row', () => {
  const t = setup();
  t.claude('StopFailure', { error: 'rate_limit', error_details: { resets_at: '2026-11-02T12:00:00Z' } });
  t.claude('StopFailure', { error: 'rate_limit' });
  assert.equal(t.limits[0].resetsAt, '2026-11-02T12:00:00.000Z');
  assert.equal(t.limits[1].resetsAt, null);
  for (const error of ['overloaded', 'authentication_failed', 'server_error', undefined]) t.claude('StopFailure', { error });
  assert.equal(t.limits.length, 2);
  assert.ok(t.store.detail(t.id).activity.some((a) => a.event === 'stop_failure' && a.summary === 'overloaded'));
});

test('StopFailure rate_limit is ignored for unlinked sessions and ended runs', () => {
  const t = setup();
  t.hooks.handle({ session_id: 'other', hook_event_name: 'StopFailure', error: 'rate_limit' });
  t.store.stopRun(t.id);
  t.claude('StopFailure', { error: 'rate_limit' });
  assert.equal(t.limits.length, 0);
});

test('the hook answers before the hand-off work runs (deferred)', () => {
  const store = openStore(tmp());
  const queued = [];
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), defer: (fn) => queued.push(fn), onLimit: () => { throw new Error('boom'); } });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  assert.deepEqual(hooks.handle({ session_id: 'cs', hook_event_name: 'StopFailure', error: 'rate_limit' }), {});
  assert.equal(queued.length, 1);
  assert.doesNotThrow(() => queued[0]());
});

test('Claude events note the cwd of a Claude run, and stop noting once Codex owns it', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: 'C:\\w\\other' });
  assert.deepEqual(JSON.parse(t.store.getRun(t.id).cwds_json), ['C:\\w\\other', 'C:\\w\\repo']);
  handOver(t);
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: 'C:\\w\\third' });
  assert.equal(JSON.parse(t.store.getRun(t.id).cwds_json).length, 2);
});

test('ownership: Claude tools on a handed-over run are denied, with and without agent_id', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  t.claude('SubagentStart', { agent_id: 'sub1', agent_type: 'worker' });
  handOver(t);
  const main = t.claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } });
  assert.ok(denied(main));
  assert.equal(reason(main), `Agent Monitor: run handed over to Codex (run ${t.id}). Stop work and report back.`);
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'sub1', tool_input: { command: 'ls' } })));
  assert.ok(denied(t.claude('PreToolUse', { tool_name: `${MCP}complete_stage`, tool_input: { run: t.id, stage: 'frame', outcome: 'done' } })));
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Agent', agent_id: 'new-one', tool_input: {} })));
});

test('ownership exceptions: get_run, list_runs, get_workflow, log and respond are allowed through the session', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  handOver(t);
  for (const name of ['get_run', 'list_runs', 'get_workflow', 'respond']) {
    assert.ok(!denied(t.claude('PreToolUse', { tool_name: `${MCP}${name}`, tool_input: { run: t.id } })), name);
  }
  assert.ok(!denied(t.claude('PreToolUse', { tool_name: `${MCP}log`, tool_input: { note: 'x' } })));
  // respond keeps its subagent guard
  assert.ok(denied(t.claude('PreToolUse', { tool_name: `${MCP}respond`, agent_id: 'sub1', tool_input: { run: t.id, action: 'Resume' } })));
});

test('ownership: complete_stage and log naming a Codex run are denied even from an unlinked session', () => {
  const t = setup();
  handOver(t);
  for (const name of ['complete_stage', 'log']) {
    const out = t.hooks.handle({ session_id: 'stranger', hook_event_name: 'PreToolUse', tool_name: `${MCP}${name}`, tool_input: { run: t.id, note: 'n' } });
    assert.ok(denied(out), name);
  }
  // another run is untouched
  const { run } = t.store.startRun({ title: 'Other' });
  assert.deepEqual(t.hooks.handle({ session_id: 'stranger', hook_event_name: 'PreToolUse', tool_name: `${MCP}log`, tool_input: { run: run.id, note: 'n' } }), {});
});

test('ownership ends with the run: a done or stopped Codex run denies nothing new', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  handOver(t);
  t.store.stopRun(t.id);
  assert.ok(!denied(t.hooks.handle({ session_id: 'stranger', hook_event_name: 'PreToolUse', tool_name: `${MCP}log`, tool_input: { run: t.id, note: 'n' } })));
});

test('AC9: a stopped run denies new subagents only until the main session next submits a prompt', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  t.claude('SubagentStart', { agent_id: 'old', agent_type: 'worker' });
  t.store.stopRun(t.id);
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'fresh1', tool_input: { command: 'ls' } })), 'before the prompt');
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'old', tool_input: { command: 'ls' } })));

  t.claude('UserPromptSubmit', { prompt: 'new task' });
  const after = t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'fresh2', tool_input: { command: 'ls' } });
  assert.deepEqual(after, {});
  assert.equal(t.store.getAgent('fresh2'), null, 'the new subagent does not join the stopped run');
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'old', tool_input: { command: 'ls' } })), 'known subagents stay denied');
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Bash', agent_id: 'fresh1', tool_input: { command: 'ls' } })), 'the agent that joined before stays denied');
});

test('AC9: a subagent prompt does not release the session, and a live run is not released', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  t.claude('UserPromptSubmit', { agent_id: 'sub', prompt: 'x' });
  t.claude('UserPromptSubmit', { prompt: 'x' });
  assert.equal(t.store.sessionRun('cs')?.id, t.id);
  t.store.stopRun(t.id);
  t.claude('UserPromptSubmit', { agent_id: 'sub', prompt: 'x' });
  assert.equal(t.store.sessionRun('cs', { adoptStopped: true })?.id, t.id);
});

test('a prompt frees the main session from a handed-over run', () => {
  const t = setup();
  t.claude('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  handOver(t);
  assert.ok(denied(t.claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } })));
  t.claude('UserPromptSubmit', { prompt: 'go on' });
  assert.deepEqual(t.claude('PreToolUse', { tool_name: 'Edit', tool_input: { file_path: 'a' } }), {});
});

test('Codex side: events resolve by thread id, the main agent is codex:<thread>, all agents are provider codex', () => {
  const t = setup();
  handOver(t);
  assert.deepEqual(t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } }), {});
  t.codex('PreToolUse', { tool_name: 'shell', agent_id: 'sub-a', agent_type: 'sonnet-engineer', tool_input: { command: 'ls' } });
  const d = t.store.detail(t.id);
  const ids = d.agents.map((a) => a.id).sort();
  assert.ok(ids.includes('codex:thr') && ids.includes('sub-a'));
  assert.ok(d.agents.filter((a) => a.id === 'codex:thr' || a.id === 'sub-a').every((a) => a.provider === 'codex'));
  assert.equal(d.agents.find((a) => a.id === 'codex:thr').type, 'codex');
  // Codex events never note a cwd or trigger a limit
  t.codex('StopFailure', { error: 'rate_limit' });
  assert.equal(t.limits.length, 0);
  // an unrelated thread is dropped
  assert.deepEqual(t.hooks.handle({ session_id: 'nobody', hook_event_name: 'PreToolUse', tool_name: 'shell' }, 'codex'), {});
});

test('Codex side: complete_stage through the MCP name links the thread and records the reported stage', () => {
  const t = setup();
  handOver(t);
  t.codex('PostToolUse', { tool_name: `${MCP}complete_stage`, agent_id: 'sub-a', tool_input: { run: t.id, stage: 'frame', outcome: 'done' }, tool_response: 'RUN x' });
  assert.equal(t.store.getAgent('sub-a').provider, 'codex');
  assert.equal(JSON.parse(t.store.getAgent('sub-a').reported_nodes)[0], 'frame');
  const alt = t.codex('PostToolUse', { tool_name: 'agent-monitor.get_run', tool_input: { run: t.id } });
  assert.deepEqual(alt, {});
});

test('Codex side: respond and direct API calls are denied, with and without agent_id', () => {
  const t = setup();
  handOver(t);
  assert.equal(reason(t.codex('PreToolUse', { tool_name: `${MCP}respond`, tool_input: { run: t.id, action: 'Resume' } })), 'Agent Monitor: only Ryan answers gates.');
  assert.ok(denied(t.codex('PreToolUse', { tool_name: `${MCP}respond`, agent_id: 'sub-a', tool_input: {} })));
  const call = { tool_name: 'shell', tool_input: { command: 'curl http://127.0.0.1:4747/api/runs/x/respond' } };
  assert.ok(denied(t.codex('PreToolUse', call)));
  assert.ok(denied(t.codex('PreToolUse', { ...call, agent_id: 'sub-a' })));
  assert.ok(denied(t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: ['curl', 'localhost:4747/x'] } })));
  assert.ok(!denied(t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'curl http://127.0.0.1:9/x' } })));
});

test('AC7: a stopped run denies every non-Agent-Monitor Codex tool, with and without agent_id, and Codex hooks keep working', () => {
  const t = setup();
  handOver(t);
  t.codex('PreToolUse', { tool_name: 'shell', agent_id: 'sub-a', tool_input: { command: 'ls' } });
  t.store.stopRun(t.id);
  assert.ok(denied(t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } })));
  assert.ok(denied(t.codex('PreToolUse', { tool_name: 'shell', agent_id: 'sub-a', tool_input: { command: 'ls' } })));
  assert.ok(denied(t.codex('PreToolUse', { tool_name: 'shell', agent_id: 'brand-new', tool_input: { command: 'ls' } })));
  assert.ok(!denied(t.codex('PreToolUse', { tool_name: `${MCP}get_run`, tool_input: { run: t.id } })));
});

test('Codex Stop events do not try to read a Claude transcript', () => {
  const t = setup();
  handOver(t);
  t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' }, transcript_path: 'C:\\nope.jsonl' });
  assert.deepEqual(t.codex('Stop', { transcript_path: 'C:\\nope.jsonl' }), {});
  const a = t.store.getAgent('codex:thr');
  assert.equal(a.transcript_path, null);
  assert.equal(a.input_tokens, 0);
});

test('Codex main thread: second and later events keep recording tool calls and activity', () => {
  const t = setup();
  handOver(t);
  t.codex('PreToolUse', { tool_name: 'shell', tool_input: { command: 'ls' } });
  t.codex('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: 'x' } });
  t.codex('PostToolUse', { tool_name: 'apply_patch', tool_input: { command: 'x' }, tool_response: 'ok' });
  const a = t.store.getAgent('codex:thr');
  assert.equal(a.tool_calls, 2);
  assert.equal(a.last_tool, 'apply_patch');
  const rows = t.store.detail(t.id).activity.filter((r) => r.agentId === 'codex:thr' && r.event === 'tool');
  assert.deepEqual(rows.map((r) => r.tool).sort(), ['apply_patch', 'shell']);
});
