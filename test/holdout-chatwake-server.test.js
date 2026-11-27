// Verifier holdouts: onChatLimit wiring in src/server.js with the chat wake. Fake manager, fake spawn, temp registry only.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp } from './codex-helpers.js';
import { makeRegistry, makeSpawn, delivering, emit, initEv, argAfter, uuid, HELPER_ID, NOTICE, sleep, until } from './holdout-chatwake-helpers.js';

const A = uuid(11);
const B = uuid(12);
// Real live pids, because the server uses the default liveness check.
const E1 = { pid: process.pid, sessionId: A, name: 'Nike Board' };
const E2 = { pid: process.ppid, sessionId: B, name: 'persist-ai-59' };

async function setup(t, decisions, { entries = [E1], sessions = true, behave } = {}) {
  const reg = makeRegistry();
  for (const e of entries) reg.write(e);
  const spawn = makeSpawn(behave ? behave(reg) : delivering(reg));
  const handled = [];
  const manager = { hasAccounts: () => true, recordRateLimit() {}, close() {}, handleLimit: async (a) => { handled.push(a); return decisions.shift(); } };
  const notes = [];
  const kills = [];
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    accounts: {
      manager, command: process.execPath, args: [], spawn, killTree: (p) => kills.push(p), env: { PATH: process.env.PATH },
      notify: (a, b) => notes.push([a, b]), ...(sessions ? { sessionsDir: reg.dir } : {}),
    },
  });
  t.after(() => srv.close());
  const mode = (sid, permission_mode) => req(srv.port, 'POST', '/hook', { body: { session_id: sid, hook_event_name: 'Notification', permission_mode } });
  const limit = (sid) => req(srv.port, 'POST', '/hook', { body: { session_id: sid, hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: 1791655200 } } });
  const settle = async (n, spawns) => {
    await until(() => notes.length >= n && (spawns === undefined || spawn.calls.length >= spawns), 8000, 20);
    await sleep(120);
  };
  return { reg, spawn, handled, notes, kills, srv, mode, limit, settle };
}

test('switched and woken: says the chat continues by itself, names it, and sends the notice for the new account', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }]);
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await s.settle(1);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). "Nike Board" continues by itself.']]);
  assert.equal(s.spawn.calls.length, 1);
  const c = s.spawn.calls[0];
  assert.equal(c.command, process.execPath);
  assert.equal(argAfter(c.args, '--permission-mode'), 'bypassPermissions');
  assert.ok(c.stdin.includes(NOTICE('b')));
});

test('the chat permission mode comes from the hooks: a default-mode chat is woken with a manual helper', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }]);
  await s.mode(A, 'default');
  await s.limit(A);
  await s.settle(1, 1);
  assert.equal(argAfter(s.spawn.calls[0].args, '--permission-mode'), 'manual');
});

test('woken, but the login was already switched earlier: "Claude chat continues"', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: false, duplicate: true }]);
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await s.settle(1);
  assert.deepEqual(s.notes, [['Claude chat continues', '"Nike Board" continues on b.']]);
});

test('every chat that stopped at the same limit is woken, also when the switch already happened', async (t) => {
  const s = await setup(t, [
    { hitAccount: 'a', next: 'b', switched: true },
    { hitAccount: 'a', next: 'b', switched: false, duplicate: true },
  ], { entries: [E1, E2] });
  await s.mode(A, 'bypassPermissions');
  await s.mode(B, 'bypassPermissions');
  await s.limit(A);
  await until(() => s.notes.length === 1);
  await s.limit(B);
  await s.settle(2, 2);
  assert.equal(s.spawn.calls.length, 2);
  assert.deepEqual(s.notes.map((n) => n[1]).sort(), ['"persist-ai-59" continues on b.', 'Now on b (a hit its usage limit). "Nike Board" continues by itself.'].sort());
});

test('a repeated StopFailure for the same chat does not wake it twice', async (t) => {
  const s = await setup(t, [
    { hitAccount: 'a', next: 'b', switched: true },
    { hitAccount: 'a', next: 'b', switched: false, duplicate: true },
  ]);
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await until(() => s.notes.length === 1);
  await s.limit(A);
  await sleep(400);
  assert.equal(s.spawn.calls.length, 1);
});

test('wake fails, switch happened: asks to type continue in the named chat; an unknown chat keeps today\'s exact text', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }, { hitAccount: 'a', next: 'b', switched: true }]);
  // no permission mode noted for A, so the wake cannot run
  await s.limit(A);
  await s.settle(1);
  await s.limit(uuid(500)); // not in the registry
  await s.settle(2);
  assert.equal(s.spawn.calls.length, 0);
  assert.deepEqual(s.notes, [
    ['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in "Nike Board".'],
    ['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in the chat that stopped.'],
  ]);
});

test('wake fails, no switch this time: a real chat is named; a forged id stays quiet', async (t) => {
  const d = { hitAccount: 'a', next: 'b', switched: false, duplicate: true };
  const s = await setup(t, [d, d, d]);
  await s.limit(A); // real chat, no mode known, so the wake fails
  await s.settle(1);
  assert.equal(s.notes.length, 1);
  assert.equal(s.notes[0][1], 'Type "continue" in "Nike Board".');
  await s.limit(uuid(501));
  await s.limit('not-even-a-uuid');
  await sleep(400);
  assert.equal(s.notes.length, 1, 'forged StopFailures must not notify');
  assert.equal(s.spawn.calls.length, 0);
});

test('no next account: today\'s notifications, and no helper is ever started', async (t) => {
  const s = await setup(t, [
    { hitAccount: null, next: null, error: 'the live login is not a saved account' },
    { hitAccount: 'b', next: null, duplicate: false },
    { hitAccount: 'a', next: null, duplicate: true },
  ]);
  await s.mode(A, 'bypassPermissions');
  for (let i = 1; i <= 3; i++) { await s.limit(A); await until(() => s.handled.length === i); await sleep(60); }
  await s.settle(2);
  assert.deepEqual(s.notes, [
    ['Claude account switch failed', 'the live login is not a saved account'],
    ['Claude accounts all out', 'Every Claude account is at its usage limit.'],
  ]);
  assert.equal(s.spawn.calls.length, 0);
});

test('loop guard: a StopFailure from the helper own session is ignored (no limit handling, no note, no wake)', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }, { hitAccount: 'a', next: 'b', switched: true }], {
    entries: [E1, { pid: process.ppid, sessionId: HELPER_ID, name: 'agent-monitor' }],
  });
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await s.settle(1);
  assert.equal(s.handled.length, 1);
  await s.mode(HELPER_ID, 'bypassPermissions');
  await s.limit(HELPER_ID);
  await sleep(500);
  assert.equal(s.handled.length, 1, 'handleLimit not called for the helper');
  assert.equal(s.notes.length, 1);
  assert.equal(s.spawn.calls.length, 1);
});

test('without accounts.sessionsDir the wake is off: today\'s behaviour, nothing spawned', async (t) => {
  const s = await setup(t, [
    { hitAccount: 'a', next: 'b', switched: true },
    { hitAccount: 'a', next: 'b', switched: false, duplicate: true },
  ], { sessions: false });
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await until(() => s.notes.length === 1);
  await s.limit(A);
  await until(() => s.handled.length === 2);
  await sleep(300);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in the chat that stopped.']]);
  assert.equal(s.spawn.calls.length, 0);
});

test('closing the server kills a helper that is still running', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }], { behave: () => (call) => emit(call, initEv()) });
  await s.mode(A, 'bypassPermissions');
  await s.limit(A);
  await until(() => s.spawn.calls.length === 1);
  t.after(() => assert.ok(s.kills.includes(s.spawn.calls[0].child.pid), 'killTree called with the helper pid')); // runs after the server close hook

});
