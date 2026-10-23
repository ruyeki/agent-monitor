// EXPLOIT: a subagent of a run Ryan stopped escapes the PreToolUse stop-deny by calling an
// exempt agent-monitor MCP tool (start_run, or get_run/log on another run). The PostToolUse
// link() re-points the agent's run_id, so its next tool calls resolve to an active run.
// Secure behaviour asserted: once stopped, the agent's non-monitor tool calls stay denied.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient, hook, runIdOf } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const SID = 'sess-stop-escape';
const base = (aid) => ({ session_id: SID, transcript_path: 'x.jsonl', cwd: '.', agent_id: aid, agent_type: 'sonnet-engineer' });
const bash = (aid) => hook(S.port, { ...base(aid), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'git push origin feature' }, tool_use_id: `tu-${Math.random()}` });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';

async function linkedStoppedAgent(aid, title) {
  const run = runIdOf((await M.call('start_run', { title })).text);
  await hook(S.port, { ...base(aid), hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run }, tool_response: [{ type: 'text', text: `RUN ${run}` }] });
  assert.equal((await S.api('POST', `/api/runs/${run}/stop`)).status, 200);
  assert.ok(denied(await bash(aid)), 'sanity: stop-deny is active before the escape');
  return run;
}

test('stopped subagent cannot escape the deny by calling start_run', async () => {
  const aid = 'agent-escape-1';
  await linkedStoppedAgent(aid, 'victim one');
  // The subagent calls mcp__agent-monitor__start_run: PreToolUse is exempt (MCP prefix), so it runs.
  assert.ok(!denied(await hook(S.port, { ...base(aid), hook_event_name: 'PreToolUse', tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'escape hatch' }, tool_use_id: 'tu-sr' })));
  const out = (await M.call('start_run', { title: 'escape hatch' })).text;
  await hook(S.port, { ...base(aid), hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'escape hatch' }, tool_response: [{ type: 'text', text: out }], tool_use_id: 'tu-sr' });
  assert.ok(denied(await bash(aid)), 'after start_run the stopped subagent can run Bash again (stop bypassed)');
});

test('stopped subagent cannot escape the deny by calling get_run on another active run', async () => {
  const aid = 'agent-escape-2';
  await linkedStoppedAgent(aid, 'victim two');
  const other = runIdOf((await M.call('start_run', { title: 'someone elses run' })).text);
  await hook(S.port, { ...base(aid), hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: other }, tool_response: [{ type: 'text', text: `RUN ${other}` }] });
  assert.ok(denied(await bash(aid)), 'after get_run(other) the stopped subagent can run Bash again (stop bypassed)');
});
