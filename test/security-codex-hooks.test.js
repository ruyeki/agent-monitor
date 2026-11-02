// EXPLOITS on the Codex side of the hooks (/hook/codex). No Codex is launched: the run is put on Codex through the store.
// 1. Stop escape (AC7): the Codex main thread has no agent_id, so its run comes from its session links. Agent-monitor tools
//    are exempt from the stop-deny, and a PostToolUse get_run/start_run on another run links the thread to that run, which
//    is then the most recently active link: every later tool call resolves to the live run and is allowed.
// 2. Self-approval: the Codex self-API deny is a regex over the command text; a computed port passes it, and the hand-off
//    profile gives Codex network access, so Codex can answer its own gate through POST /api/runs/:id/respond.
// Secure behaviour asserted: a stopped Codex run keeps denying its thread's tools; Codex cannot reach the respond route.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient, req } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch { /* closed */ } await S?.srv.close(); });

const codex = (body) => req(S.port, 'POST', '/hook/codex', { body });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';

function codexRun(title, thread) {
  const st = S.srv.store;
  const id = st.startRun({ title }).run.id;
  assert.ok(st.markLimit(id, { source: 'stopfailure' }));
  st.handOver(id);
  st.setCodexThread(id, thread);
  return id;
}

test('a stopped Codex thread cannot escape the deny by calling get_run on another run', async () => {
  const run = codexRun('codex victim', 'thr-stop');
  const other = S.srv.store.startRun({ title: 'some other live run' }).run.id;
  const shell = () => codex({ session_id: 'thr-stop', hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: ['git', 'push'] } });
  assert.equal((await S.api('POST', `/api/runs/${run}/stop`)).status, 200);
  assert.ok(denied(await shell()), 'sanity: the stop-deny holds before the escape');

  // get_run is exempt from the stop-deny; its PostToolUse links the thread to the other run
  assert.ok(!denied(await codex({ session_id: 'thr-stop', hook_event_name: 'PreToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: other } })));
  await codex({ session_id: 'thr-stop', hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: other }, tool_response: [{ type: 'text', text: `RUN ${other}` }] });

  assert.ok(denied(await shell()), 'after get_run on another run the stopped Codex thread runs shell commands again');
});
