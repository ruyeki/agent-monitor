// EXPLOIT: the new PreToolUse deny stops a subagent calling mcp__agent-monitor__respond, but the
// same subagent can approve Ryan's gate with one Bash curl to the REST API or to /mcp directly:
// the hook does not look at Bash commands, and the server accepts any local request with no Origin.
// Secure behaviour asserted (fix-agnostic): either the hook denies the subagent's Bash call, or the
// request it makes is refused; in both cases the gate stays waiting on Ryan.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient, hook, runIdOf, req } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const SID = 'sess-gate-bypass';
const AID = 'agent-gate-bypass';
const base = { session_id: SID, transcript_path: 'x.jsonl', cwd: '.', agent_id: AID, agent_type: 'sonnet-engineer' };
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';

async function runAtGate(title) {
  const run = runIdOf((await M.call('start_run', { title })).text);
  await M.call('complete_stage', { run, stage: 'frame', outcome: 'pass' });
  await hook(S.port, { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run }, tool_response: [{ type: 'text', text: `RUN ${run}` }] });
  assert.equal((await S.api('GET', `/api/runs/${run}`)).json.run.status, 'waiting');
  return run;
}

async function attempt(run, command, send) {
  const pre = await hook(S.port, { ...base, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command }, tool_use_id: `tu-${run}` });
  if (!denied(pre)) await send(); // Claude Code would run the command
  const after = (await S.api('GET', `/api/runs/${run}`)).json.run;
  assert.equal(after.status, 'waiting', `subagent approved gate1 itself: run is now at '${after.stage}' (${after.status})`);
}

test('subagent cannot approve a gate with curl to /api/runs/:id/respond', async () => {
  const run = await runAtGate('rest bypass');
  const cmd = `curl -s -X POST -H 'Content-Type: application/json' -d '{"action":"Agree spec","text":"ok"}' http://127.0.0.1:${S.port}/api/runs/${run}/respond`;
  await attempt(run, cmd, () => S.api('POST', `/api/runs/${run}/respond`, { body: { action: 'Agree spec', text: 'ok' } }));
});

test('subagent cannot approve a gate with curl to /mcp tools/call respond', async () => {
  const run = await runAtGate('mcp bypass');
  const rpc = { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'respond', arguments: { run, action: 'Agree spec' } } };
  const cmd = `curl -s -H 'Content-Type: application/json' -H 'Accept: application/json, text/event-stream' -d '${JSON.stringify(rpc)}' http://127.0.0.1:${S.port}/mcp`;
  await attempt(run, cmd, () => req(S.port, 'POST', '/mcp', { body: rpc, headers: { Accept: 'application/json, text/event-stream' } }));
});
