import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp, fixture } from './helpers.js';

const START = 'mcp__agent-monitor__start_run';

function setup(extra = {}) {
  const store = openStore(tmp());
  const projectsDir = tmp('am-projects');
  let now = 1_000_000;
  const hooks = createHooks(store, { projectsDir, ...extra, defer: (fn) => fn(), clock: () => now });
  const sessionFile = path.join(projectsDir, 'proj', 's1.jsonl');
  fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
  fs.writeFileSync(sessionFile, 'existing line\n');
  const send = (hook_event_name, extra = {}) => hooks.handle({ session_id: 's1', transcript_path: sessionFile, cwd: '/x', hook_event_name, ...extra });
  const agents = (run = 'r1', withMain = false) => (store.detail(run)?.agents ?? []).filter((a) => withMain || a.type !== 'main');
  const startRun = (title = 'R1') => store.startRun({ title });
  const linkSession = (run = 'r1', extra = {}) => send('PostToolUse', {
    tool_name: START, tool_input: { title: 'R1' }, tool_response: { content: [{ type: 'text', text: `RUN ${run} · stage frame (Frame)` }] }, tool_use_id: 't0', ...extra,
  });
  return { store, projectsDir, hooks, send, agents, startRun, linkSession, sessionFile, tick: (ms) => { now += ms; } };
}

test('sessions that are not linked to a run are dropped', () => {
  const t = setup();
  t.startRun();
  assert.deepEqual(t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'a' }), {});
  t.send('SubagentStart', { agent_id: 'sub1', agent_type: 'general-purpose' });
  assert.deepEqual(t.agents(), []);
  assert.equal(t.store.activityCount('r1'), 0);
});

test('start_run PostToolUse links the session; later events create the main agent row', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm   test\n--all' }, tool_use_id: 'a' });
  const [main] = t.agents('r1', true);
  assert.equal(main.id, 'main:s1');
  assert.equal(main.type, 'main');
  assert.equal(main.lastTool, 'Bash');
  assert.equal(main.lastSummary, 'npm test --all');
  assert.equal(main.toolCalls, 1);
  assert.equal(t.store.detail('r1').activity[0].summary, 'npm test --all');
});

test('other agent-monitor tools link by tool_input.run; a missing run is ignored', () => {
  const t = setup();
  t.startRun();
  t.send('PostToolUse', { tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: 'nope' }, tool_response: 'x', tool_use_id: 'a' });
  assert.equal(t.store.sessionRun('s1'), null);
  t.send('PostToolUse', { tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: 'r1' }, tool_response: 'x', tool_use_id: 'b' });
  assert.equal(t.store.sessionRun('s1').id, 'r1');
});

test('agents keep the nodes active when they appeared and the stages they report with complete_stage', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.store.completeStage('r1', { stage: 'frame', outcome: 'pass' });
  t.store.respond('r1', { action: 'Agree spec' });
  t.store.completeStage('r1', { stage: 'plan', outcome: 'done' });
  t.send('SubagentStart', { agent_id: 'w1', agent_type: 'sonnet-engineer' });
  assert.deepEqual(JSON.parse(t.store.getAgent('w1').start_nodes), ['implement', 'prep']);
  const report = (extra) => t.send('PostToolUse', { tool_name: 'mcp__agent-monitor__complete_stage', tool_response: 'x', tool_use_id: 'c', ...extra });
  report({ agent_id: 'w1', tool_input: { run: 'r1', stage: 'implement', outcome: 'pass' } });
  report({ agent_id: 'w1', tool_input: { run: 'r1', stage: 'implement', outcome: 'pass' } });
  report({ agent_id: 'w1', tool_input: { run: 'r1', stage: 'prep', outcome: 'pass' } });
  report({ agent_id: 'w1', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: 'r1', stage: 'verify' } });
  report({ tool_input: { run: 'r1', stage: 'verify', outcome: 'pass' } });
  assert.deepEqual(JSON.parse(t.store.getAgent('w1').reported_nodes), ['implement', 'prep']);
  assert.deepEqual(JSON.parse(t.store.getAgent('main:s1').reported_nodes), [], 'the main session has no agent_id: nothing recorded');
  report({ agent_id: 'lead2', tool_input: { run: 'r1', stage: 'verify', outcome: 'pass' } });
  assert.deepEqual(JSON.parse(t.store.getAgent('lead2').reported_nodes), ['verify'], 'an agent first seen on complete_stage');
  report({ agent_id: 'lead2', tool_response: 'ERROR: nope', tool_input: { run: 'r1', stage: 'review', outcome: 'pass' } });
  report({ agent_id: 'lead2', tool_response: { isError: true, content: [] }, tool_input: { run: 'r1', stage: 'whitehat', outcome: 'pass' } });
  assert.deepEqual(JSON.parse(t.store.getAgent('lead2').reported_nodes), ['verify'], 'failed complete_stage calls are not recorded');
});

test('an agent-monitor call with agent_id links that agent, not the session', () => {
  const t = setup();
  t.startRun();
  t.linkSession('r1', { agent_id: 'lead1', agent_type: 'fable-lead' });
  assert.equal(t.store.sessionRun('s1'), null);
  assert.deepEqual(t.agents().map((a) => [a.id, a.type]), [['lead1', 'fable-lead']]);
  t.send('PreToolUse', { agent_id: 'lead1', agent_type: 'fable-lead', tool_name: 'Read', tool_input: { file_path: '/a/b.js' }, tool_use_id: 'x' });
  assert.equal(t.agents()[0].lastSummary, '/a/b.js');
  t.send('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b.js' }, tool_use_id: 'y' });
  assert.equal(t.agents().length, 1); // main of this session is not linked
});

test('SubagentStart and unknown agent ids join the most recently active open run of the session', () => {
  const t = setup();
  t.startRun('R1');
  t.store.startRun({ title: 'R2' });
  t.linkSession('r1');
  t.linkSession('r2', { tool_use_id: 't1' });
  t.send('SubagentStart', { agent_id: 'sub1', agent_type: 'sonnet-engineer' });
  assert.deepEqual(t.agents('r2').map((a) => a.id), ['sub1']);
  assert.equal(t.agents('r2')[0].type, 'sonnet-engineer');
  t.send('PreToolUse', { agent_id: 'sub2', agent_type: 'verifier', tool_name: 'Grep', tool_input: { pattern: 'foo' }, tool_use_id: 'z' });
  assert.deepEqual(t.agents('r2').map((a) => a.id), ['sub1', 'sub2']);
  assert.deepEqual(t.agents('r1'), []);
  // a stopped run still counts as the latest run: a new subagent joins it (and is denied), not the older open run
  t.store.stopRun('r2');
  t.send('SubagentStart', { agent_id: 'sub3', agent_type: 'x' });
  assert.deepEqual(t.agents('r2').map((a) => a.id), ['sub1', 'sub2', 'sub3']);
  assert.deepEqual(t.agents('r1'), []);
});

test('per-agent tracking: summaries, errors, permission waiting, notifications', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  const base = { agent_id: 'a1', agent_type: 'worker' };
  t.send('SubagentStart', base);
  const long = 'x'.repeat(300);
  t.send('PreToolUse', { ...base, tool_name: 'Bash', tool_input: { command: long }, tool_use_id: 'u1' });
  assert.equal(t.agents()[0].lastSummary.length, 120);
  t.send('PreToolUse', { ...base, tool_name: 'WebFetch', tool_input: { url: 'http://u', prompt: 'p' }, tool_use_id: 'u2' });
  assert.equal(t.agents()[0].lastSummary, 'http://u');
  t.send('PreToolUse', { ...base, tool_name: 'Odd', tool_input: { n: 1, other: 'first string' }, tool_use_id: 'u3' });
  assert.equal(t.agents()[0].lastSummary, 'first string');
  assert.equal(t.agents()[0].toolCalls, 3);

  t.send('PermissionRequest', { ...base, tool_name: 'Bash', tool_input: { command: 'rm x' } });
  assert.equal(t.agents()[0].waitingPermission, true);
  t.send('PostToolUse', { ...base, tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'u1' });
  assert.equal(t.agents()[0].waitingPermission, false);

  t.send('PostToolUseFailure', { ...base, tool_name: 'Bash', tool_input: {}, error: 'boom', tool_use_id: 'u2' });
  assert.deepEqual([t.agents()[0].errors, t.agents()[0].lastError], [1, 'boom']);

  t.send('Notification', { message: 'Claude needs your permission', notification_type: 'permission_prompt' });
  t.send('Stop');
  const events = t.store.detail('r1').activity.map((a) => a.event);
  assert.ok(events.includes('notification') && events.includes('stop') && events.includes('error'));
});

test('PermissionRequest without agent_id is matched to the pending call, else to main', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  t.send('PreToolUse', { agent_id: 'a1', agent_type: 'worker', tool_name: 'Edit', tool_input: { b: 2, a: 1 }, tool_use_id: 'e1' });
  t.send('PermissionRequest', { tool_name: 'Edit', tool_input: { a: 1, b: 2 } });
  const by = Object.fromEntries(t.agents('r1', true).map((a) => [a.id, a.waitingPermission]));
  assert.equal(by.a1, true);
  assert.equal(by['main:s1'] ?? false, false);
  t.send('PermissionRequest', { tool_name: 'Write', tool_input: { file_path: 'q' } });
  assert.equal(t.store.getAgent('main:s1').waiting_permission, 1);
});

test('SubagentStop finishes the agent, keeps 300 chars and reads tokens from the derived transcript path', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const dir = path.join(t.projectsDir, 'proj', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), path.join(dir, 'agent-a1.jsonl'));
  fs.writeFileSync(path.join(dir, 'agent-a1.meta.json'), JSON.stringify({ agentType: 'worker', description: 'Build the thing', model: 'sonnet' }));
  t.send('SubagentStop', { agent_id: 'a1', agent_type: 'worker', last_assistant_message: 'y'.repeat(500) });
  const a = t.agents()[0];
  assert.equal(a.status, 'finished');
  assert.ok(a.finishedAt);
  assert.equal(t.store.getAgent('a1').last_message.length, 300);
  assert.deepEqual(a.tokens, { input: 12, output: 5210, cacheCreation: 53667, cacheRead: 361757 });
  assert.equal(a.model, 'claude-opus-5-5');
  assert.equal(a.description, 'Build the thing');
  // a second stop (or read) does not double count
  t.send('SubagentStop', { agent_id: 'a1', agent_type: 'worker', last_assistant_message: 'again' });
  assert.equal(t.agents()[0].tokens.output, 5210);
});

test('SubagentStop prefers agent_transcript_path, and paths outside projectsDir are ignored', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const outside = path.join(tmp(), 'evil.jsonl');
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), outside);
  t.send('SubagentStop', { agent_id: 'a1', agent_transcript_path: outside, last_assistant_message: 'x' });
  assert.equal(t.agents()[0].tokens.output, 0);
  const inside = path.join(t.projectsDir, 'proj', 'custom.jsonl');
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), inside);
  t.send('SubagentStop', { agent_id: 'a1', agent_transcript_path: inside, last_assistant_message: 'x' });
  assert.equal(t.agents()[0].tokens.output, 5210);
});

test('main agent tokens start at the transcript size when linked, and PostToolUse reads at most every 5 s', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'a' }, tool_use_id: 'a' });
  assert.equal(t.store.getAgent('main:s1').transcript_offset, fs.statSync(t.sessionFile).size);
  const line = (id, n) => `${JSON.stringify({ message: { id, usage: { input_tokens: n, output_tokens: 0 } } })}\n`;
  fs.appendFileSync(t.sessionFile, line('m1', 10));
  t.tick(6000);
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'a' });
  assert.equal(t.store.getAgent('main:s1').input_tokens, 10);
  fs.appendFileSync(t.sessionFile, line('m2', 5));
  t.tick(1000);
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'b' });
  assert.equal(t.store.getAgent('main:s1').input_tokens, 10); // throttled
  t.tick(5000);
  t.send('PostToolUse', { tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'c' });
  assert.equal(t.store.getAgent('main:s1').input_tokens, 15);
});

test('Stop and SessionEnd read the main transcript, unthrottled', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'a' }, tool_use_id: 'a' });
  const line = (id, n) => `${JSON.stringify({ message: { id, usage: { input_tokens: n, output_tokens: 0 } } })}
`;
  fs.appendFileSync(t.sessionFile, line('m1', 7));
  t.send('Stop');
  assert.equal(t.store.getAgent('main:s1').input_tokens, 7);
  fs.appendFileSync(t.sessionFile, line('m2', 3));
  t.send('SessionEnd');
  assert.equal(t.store.getAgent('main:s1').input_tokens, 10);
});

test('agent_transcript_path that is the same file in another spelling does not double count; a different file recounts', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const dir = path.join(t.projectsDir, 'proj', 's1', 'subagents');
  fs.mkdirSync(dir, { recursive: true });
  const real = path.join(dir, 'agent-a1.jsonl');
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), real);
  t.send('SubagentStop', { agent_id: 'a1', last_assistant_message: 'x' });
  assert.equal(t.agents()[0].tokens.output, 5210);
  // same file, other spelling: unnormalised segments, forward slashes and upper case on Windows
  const dotted = `${dir}${path.sep}..${path.sep}subagents${path.sep}agent-a1.jsonl`;
  const spelled = process.platform === 'win32' ? dotted.split(path.sep).join('/').toUpperCase() : dotted;
  t.send('SubagentStop', { agent_id: 'a1', agent_transcript_path: spelled, last_assistant_message: 'x' });
  assert.equal(t.agents()[0].tokens.output, 5210);
  // a really different file replaces the totals instead of adding to them
  const other = path.join(t.projectsDir, 'proj', 'other.jsonl');
  fs.copyFileSync(fixture('subagent-transcript.jsonl'), other);
  t.send('SubagentStop', { agent_id: 'a1', agent_transcript_path: other, last_assistant_message: 'x' });
  assert.equal(t.agents()[0].tokens.output, 5210);
  assert.equal(t.agents()[0].tokens.input, 12);
});

test('respond guard: a subagent may never call respond, even unlinked or in a stopped run; main may', () => {
  const t = setup();
  const reason = "Agent Monitor: only the main session relays Ryan's answers.";
  const pre = (extra) => t.send('PreToolUse', { tool_name: 'mcp__agent-monitor__respond', tool_input: { run: 'r1', action: 'Agree spec' }, tool_use_id: 'k', ...extra });
  const denied = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  assert.deepEqual(pre({ agent_id: 'a1' }), denied); // unlinked session
  assert.deepEqual(pre({}), {});
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  assert.deepEqual(pre({ agent_id: 'a1' }), denied);
  assert.deepEqual(pre({ agent_id: 'a1', tool_name: 'mcp__agent-monitor__get_run' }), {});
  assert.deepEqual(pre({}), {});
  t.store.stopRun('r1');
  assert.deepEqual(pre({ agent_id: 'a1' }), denied);
  assert.deepEqual(pre({}), {});
});

test('stop deny: subagents of a stopped run are denied, agent-monitor tools and main are not', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const pre = (extra) => t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'k', ...extra });
  assert.deepEqual(pre({ agent_id: 'a1' }), {});
  t.store.stopRun('r1');
  assert.deepEqual(pre({ agent_id: 'a1', agent_type: 'worker' }), {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Agent Monitor: run r1 was stopped by Ryan. Stop work and report back.' },
  });
  assert.deepEqual(pre({ agent_id: 'a1', tool_name: 'mcp__agent-monitor__get_run' }), {});
  assert.deepEqual(pre({}), {}); // main session, no agent_id: never denied
  assert.deepEqual(t.send('PostToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: {}, tool_response: {}, tool_use_id: 'k' }), {});
});

test('the handler never throws on junk', () => {
  const t = setup();
  for (const junk of [null, undefined, 5, 'x', [], {}, { hook_event_name: 'PreToolUse' }, { session_id: 's1', hook_event_name: 'PreToolUse', tool_input: 5 }]) {
    assert.deepEqual(t.hooks.handle(junk), {});
  }
});

test('a known agent of a stopped run is never re-linked to another run', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const other = t.store.startRun({ title: 'Other' }).run.id;
  t.store.stopRun('r1');
  const reply = { content: [{ type: 'text', text: `RUN ${other} · stage frame (Frame)` }] };
  t.send('PostToolUse', { agent_id: 'a1', tool_name: START, tool_input: { title: 'Other' }, tool_response: reply, tool_use_id: 'x1' });
  t.send('PostToolUse', { agent_id: 'a1', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: other }, tool_response: {}, tool_use_id: 'x2' });
  assert.equal(t.store.getAgent('a1').run_id, 'r1');
  const out = t.send('PreToolUse', { agent_id: 'a1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'x3' });
  assert.equal(out.hookSpecificOutput?.permissionDecision, 'deny');
});

test('a subagent start_run never moves a known agent; get_run still can while the run is live', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.send('SubagentStart', { agent_id: 'a1', agent_type: 'worker' });
  const other = t.store.startRun({ title: 'Other' }).run.id;
  const reply = { content: [{ type: 'text', text: `RUN ${other} · stage frame` }] };
  t.send('PostToolUse', { agent_id: 'a1', tool_name: START, tool_input: { title: 'Other' }, tool_response: reply, tool_use_id: 'x1' });
  assert.equal(t.store.getAgent('a1').run_id, 'r1');
  t.send('PostToolUse', { agent_id: 'a1', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: other }, tool_response: {}, tool_use_id: 'x2' });
  assert.equal(t.store.getAgent('a1').run_id, other);
});

test('subagent Bash or PowerShell aimed at the monitor port is denied; main and other targets are not', () => {
  const t = setup({ port: 4747 });
  const reason = 'Agent Monitor: subagents may not call the Agent Monitor API directly; use the mcp__agent-monitor__ tools.';
  const denied = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  const pre = (command, extra = {}) => t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: 'k', agent_id: 'a1', ...extra });
  for (const host of ['127.0.0.1', 'localhost', 'LocalHost', '[::1]', '0.0.0.0', '127.1.2.3']) {
    assert.deepEqual(pre(`curl -X POST http://${host}:4747/api/runs/r1/respond`), denied, host); // session is unlinked
  }
  assert.deepEqual(pre('Invoke-RestMethod http://127.0.0.1:4747/mcp', { tool_name: 'PowerShell' }), denied);
  assert.deepEqual(pre('curl http://127.0.0.1:4747/api/runs', { agent_id: undefined }), {}); // main session
  assert.deepEqual(pre('curl http://127.0.0.1:47470/api'), {});
  assert.deepEqual(pre('curl http://127.0.0.1:8080/api'), {});
  assert.deepEqual(pre('curl http://example.com:4747/api'), {});
  assert.deepEqual(pre('curl http://127.0.0.1:4747/api', { tool_name: 'Read' }), {});
});

const denied = (out) => out.hookSpecificOutput?.permissionDecision === 'deny';

test('a subagent started after the run was stopped joins it and is denied; agent-monitor tools and main are not', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.store.stopRun('r1');
  const pre = (extra) => t.send('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'k', ...extra });
  assert.deepEqual(t.send('SubagentStart', { agent_id: 'late', agent_type: 'worker' }), {});
  assert.equal(t.store.getAgent('late').run_id, 'r1');
  assert.ok(denied(pre({ agent_id: 'late' })));
  assert.ok(denied(pre({ agent_id: 'late2' }))); // first seen on a PreToolUse
  assert.equal(t.store.getAgent('late2').run_id, 'r1');
  assert.deepEqual(pre({ agent_id: 'late', tool_name: 'mcp__agent-monitor__get_run' }), {});
  assert.deepEqual(pre({}), {}); // main session is never denied
});

test('a later run in the same session takes over: its new subagents are not denied', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  t.store.stopRun('r1');
  t.store.startRun({ title: 'R2' });
  t.linkSession('r2');
  t.send('SubagentStart', { agent_id: 'b1', agent_type: 'worker' });
  assert.equal(t.store.getAgent('b1').run_id, 'r2');
  assert.deepEqual(t.send('PreToolUse', { agent_id: 'b1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'k' }), {});
});

test('a session whose latest run is done does not adopt new subagents', () => {
  const t = setup();
  t.startRun();
  t.linkSession();
  for (let i = 0; i < 30 && t.store.getRun('r1').status !== 'done'; i++) {
    const r = t.store.getRun('r1');
    if (r.status === 'waiting') t.store.respond('r1', { action: t.store.summary(r).actions[0].label, text: '' });
    else t.store.completeStage('r1', { stage: r.stage, outcome: 'pass' });
  }
  assert.equal(t.store.getRun('r1').status, 'done');
  t.send('SubagentStart', { agent_id: 'c1', agent_type: 'worker' });
  assert.equal(t.store.getAgent('c1'), null);
  assert.deepEqual(t.send('PreToolUse', { agent_id: 'c2', tool_name: 'Bash', tool_input: {}, tool_use_id: 'k' }), {});
  assert.equal(t.store.getAgent('c2'), null);
});
