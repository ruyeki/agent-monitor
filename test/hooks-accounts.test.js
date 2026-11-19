// Hooks for Claude account rotation: chat rate limits, permission modes, and the deny for sessions that no longer drive a run.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until } from './codex-helpers.js';

const MCP = 'mcp__agent-monitor__';
const denied = (out) => out?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (out) => out?.hookSpecificOutput?.permissionDecisionReason;

function setup(opts = {}) {
  const store = openStore(tmp());
  const runLimits = [];
  const chatLimits = [];
  const hooks = createHooks(store, {
    projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.parse('2026-11-02T10:00:00Z'),
    onLimit: (i) => runLimits.push(i), onChatLimit: (i) => chatLimits.push(i), ...opts,
  });
  const as = (sid) => (hook_event_name, extra = {}) => hooks.handle({ session_id: sid, cwd: 'C:\\w\\repo', hook_event_name, ...extra });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('orig', run.id);
  return { store, hooks, runLimits, chatLimits, orig: as('orig'), other: as('other'), id: run.id, as };
}

test('chat StopFailure rate_limit (a session with no live run) reaches onChatLimit with the reset time', () => {
  const t = setup();
  t.other('StopFailure', { error: 'rate_limit', error_details: { resetsAt: 1791655200 } });
  assert.deepEqual(t.chatLimits, [{ sessionId: 'other', at: '2026-11-02T10:00:00.000Z', resetsAt: new Date(1791655200 * 1000).toISOString(), source: 'stopfailure' }]);
  t.other('StopFailure', { error: 'rate_limit' });
  assert.equal(t.chatLimits[1].resetsAt, null);
  assert.equal(t.runLimits.length, 0);
});

test('chat limits skip run sessions, subagents, other errors and Codex; a stopped run is a chat', () => {
  const t = setup();
  t.orig('StopFailure', { error: 'rate_limit' });
  t.other('StopFailure', { error: 'overloaded' });
  t.other('StopFailure', { error: 'rate_limit', agent_id: 'sub-1' });
  t.hooks.handle({ session_id: 'thr', hook_event_name: 'StopFailure', error: 'rate_limit' }, 'codex');
  assert.equal(t.runLimits.length, 1);
  assert.equal(t.chatLimits.length, 0);
  t.store.stopRun(t.id);
  t.orig('StopFailure', { error: 'rate_limit' });
  assert.equal(t.chatLimits.length, 1);
});

test('chat limits fail open: a throwing or rejecting callback never breaks the hook', async () => {
  for (const onChatLimit of [() => { throw new Error('x'); }, () => Promise.reject(new Error('y'))]) {
    const t = setup({ onChatLimit });
    assert.deepEqual(t.other('StopFailure', { error: 'rate_limit' }), {});
    await new Promise((r) => setImmediate(r)); // an unhandled rejection would fail the test run
  }
  const none = setup({ onChatLimit: undefined });
  assert.deepEqual(none.other('StopFailure', { error: 'rate_limit' }), {});
});

test('permission_mode of a main session is recorded (allowlist only, never from a subagent or Codex)', () => {
  const t = setup();
  t.orig('Notification', { message: 'x', permission_mode: 'acceptEdits' });
  assert.equal(t.store.sessionMode('orig'), 'acceptEdits');
  t.orig('Notification', { message: 'x', permission_mode: 'dontAsk' });
  t.orig('Notification', { message: 'x', permission_mode: { evil: 1 } });
  assert.equal(t.store.sessionMode('orig'), 'acceptEdits');
  t.orig('Notification', { message: 'x', permission_mode: 'bypassPermissions', agent_id: 'sub-1' });
  assert.equal(t.store.sessionMode('orig'), 'acceptEdits');
  t.orig('Notification', { message: 'x', permission_mode: 'plan' });
  assert.equal(t.store.sessionMode('orig'), 'plan');
  t.other('Notification', { permission_mode: 'default' });
  assert.equal(t.store.sessionMode('other'), 'default', 'recorded even for a session with no run');
  t.hooks.handle({ session_id: 'thr', hook_event_name: 'Notification', permission_mode: 'plan' }, 'codex');
  assert.equal(t.store.sessionMode('thr'), null);
});

// The run continues headless in session 'hl' on account b; 'orig' is the stopped chat.
function headless(t) {
  t.store.resumeOnAccount(t.id, { account: 'b', hit: 'a' });
  t.store.setClaudeSession(t.id, 'hl');
}

test('another session is denied on a headless run (tools and reports); the headless session and read tools are not', () => {
  const t = setup();
  const pre = (sid, extra) => t.as(sid)('PreToolUse', { tool_use_id: `u${Math.random()}`, ...extra });
  assert.ok(!denied(pre('orig', { tool_name: 'Bash', tool_input: { command: 'ls' } })), 'before the switch: allowed');
  headless(t);
  const out = pre('orig', { tool_name: 'Bash', tool_input: { command: 'ls' } });
  assert.ok(denied(out));
  assert.equal(reason(out), `Agent Monitor: run ${t.id} continues headless on Claude account b. Stop work and report back.`);
  assert.ok(denied(pre('orig', { tool_name: `${MCP}complete_stage`, tool_input: { run: t.id, stage: 'frame', outcome: 'done' } })));
  assert.ok(denied(pre('unlinked', { tool_name: `${MCP}log`, tool_input: { run: t.id, note: 'x' } })), 'by target run, even from an unlinked session');
  assert.ok(!denied(pre('orig', { tool_name: `${MCP}get_run`, tool_input: { run: t.id } })));
  assert.ok(!denied(pre('hl', { tool_name: 'Bash', tool_input: { command: 'ls' } })));
  assert.ok(!denied(pre('hl', { tool_name: `${MCP}complete_stage`, tool_input: { run: t.id, stage: 'frame', outcome: 'done' } })));
  t.store.stopRun(t.id);
  assert.ok(!denied(pre('orig', { tool_name: 'Bash', tool_input: { command: 'ls' } })), 'a stopped run is no longer headless-driven');
});

test('UserPromptSubmit frees the session from a run a headless session drives, and keeps the headless link', () => {
  const t = setup();
  headless(t);
  t.other('Notification', {});
  t.store.linkSession('other', t.id);
  t.orig('UserPromptSubmit', { prompt: 'hi' });
  assert.equal(t.store.sessionRun('orig'), null);
  assert.equal(t.store.sessionRun('hl')?.id, t.id);
  t.as('hl')('UserPromptSubmit', { prompt: 'x' });
  assert.equal(t.store.sessionRun('hl')?.id, t.id);
});

// Chats at server level: the fake manager decides, the notifier is a recorder.
async function chatSetup(t, decisions, has = true) {
  const handled = [];
  const manager = {
    hasAccounts: () => has, recordRateLimit() {}, close() {},
    handleLimit: async (a) => { handled.push(a); return decisions.shift(); },
  };
  const notes = [];
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    accounts: { manager, command: process.execPath, args: [], notify: (a, b) => notes.push([a, b]) },
  });
  t.after(() => srv.close());
  const limit = () => req(srv.port, 'POST', '/hook', { body: { session_id: 'chat', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: 1791655200 } } });
  return { handled, notes, limit, srv };
}

test('chat limit: switched notifies which chat to continue; all out notifies once; a duplicate stays quiet', async (t) => {
  const s = await chatSetup(t, [
    { hitAccount: 'a', next: 'b', switched: true },
    { hitAccount: 'b', next: null, duplicate: false },
    { hitAccount: 'a', next: 'b', switched: false, duplicate: true },
    { hitAccount: 'a', next: null, duplicate: true },
  ]);
  for (let i = 1; i <= 4; i++) { await s.limit(); await until(() => s.handled.length === i); await new Promise((r) => setTimeout(r, 30)); }
  assert.deepEqual(s.handled[0], { runAccount: null, at: s.handled[0].at, resetsAt: new Date(1791655200 * 1000).toISOString(), source: 'stopfailure' });
  assert.deepEqual(s.notes, [
    ['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in the chat that stopped.'],
    ['Claude accounts all out', 'Every Claude account is at its usage limit.'],
  ]);
});

test('chat limit with no accounts configured does nothing', async (t) => {
  const s = await chatSetup(t, [], false);
  await s.limit();
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(s.handled.length, 0);
  assert.equal(s.notes.length, 0);
});

test('chat limit: a failed switch says so (not "all out"), once', async (t) => {
  const s = await chatSetup(t, [{ hitAccount: null, next: null, error: 'the live login is not a saved account' }]);
  await s.limit();
  await until(() => s.handled.length === 1);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(s.notes, [['Claude account switch failed', 'the live login is not a saved account']]);
});
