// Chat limits at server level with the wake on: fake manager, fake `claude` spawn, temp session registry, notification recorder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until } from './codex-helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const HELPER = '99999999-9999-4999-8999-999999999999';
const entry = { pid: process.pid, sessionId: SID, name: 'Nike Board', status: 'idle', statusUpdatedAt: 1 };
const NOTICE_B = 'Agent Monitor (automatic notice): your last turn stopped at a Claude usage limit. The login was switched to account b, which has usage left, so the limit no longer applies. This is a status notice, not a request; no reply is needed.';
const sendUse = { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: { to: 'Nike Board', message: NOTICE_B } }] } };
const resultOk = { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ success: true }) }] } };

// `behaviour`: 'deliver' flips the registry entry to busy; 'throw' makes spawn throw.
async function setup(t, decisions, { behaviour = 'deliver', registry = [entry], mode = 'bypassPermissions' } = {}) {
  const dataDir = tmp();
  const dir = tmp('am-sess-');
  for (const e of registry) fs.writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e));
  const handled = [];
  const manager = { hasAccounts: () => true, recordRateLimit() {}, close() {}, handleLimit: async (a) => { handled.push(a); return decisions.shift(); } };
  const notes = [];
  const spawned = [];
  const spawn = (command, argv, opts) => {
    if (behaviour === 'throw') throw new Error('ENOENT');
    const c = new EventEmitter();
    c.pid = 7000; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    spawned.push({ command, argv, opts });
    setImmediate(() => {
      fs.writeFileSync(path.join(dir, `${process.pid}.json`), JSON.stringify({ ...entry, status: 'busy', statusUpdatedAt: Date.now() + 1000 }));
      c.stdout.write([{ type: 'system', subtype: 'init', session_id: HELPER }, sendUse, resultOk].map((e) => `${JSON.stringify(e)}\n`).join(''));
      c.stdout.end();
      setImmediate(() => c.emit('close', 0));
    });
    return c;
  };
  const srv = await startServer({
    port: 0, dataDir, projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    accounts: { manager, command: 'fake-claude', args: [], spawn, killTree() {}, sessionsDir: dir, notify: (a, b) => notes.push([a, b]) },
  });
  t.after(() => srv.close());
  const hook = (session_id, extra) => req(srv.port, 'POST', '/hook', { body: { session_id, cwd: 'C:\w\repo', ...extra } });
  if (mode) await hook(SID, { hook_event_name: 'UserPromptSubmit', permission_mode: mode, prompt: 'x' });
  const limit = (id = SID) => hook(id, { hook_event_name: 'StopFailure', error: 'rate_limit' });
  const settle = () => new Promise((r) => setTimeout(r, 120));
  return { handled, notes, spawned, limit, settle, srv, dataDir };
}

test('wake ok: switched says the chat continues by itself; the helper has the right argv', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }]);
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). "Nike Board" continues by itself.']]);
  assert.equal(s.spawned[0].command, 'fake-claude');
  assert.ok(s.spawned[0].argv.includes('bypassPermissions'));
});

test('the helper runs in a folder Agent Monitor owns, not the shared temp folder', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }]);
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.equal(s.spawned[0].opts.cwd, path.join(s.dataDir, 'chat-wake'));
});

test('repeat StopFailures for a woken chat: one fallback notification, then silence (a forged flood is not a notification flood)', async (t) => {
  const dup = { hitAccount: 'a', next: 'b', switched: false, duplicate: true };
  const s = await setup(t, Array.from({ length: 6 }, () => ({ ...dup })));
  await s.limit();
  await until(() => s.notes.length === 1);
  for (let i = 0; i < 5; i++) await s.limit();
  await until(() => s.handled.length === 6);
  await s.settle();
  assert.equal(s.spawned.length, 1);
  assert.deepEqual(s.notes.map((n) => n[0]), ['Claude chat continues', 'Claude chat stopped']);
});

test('concurrent StopFailures during one wake: one success notification, at most one fallback', async (t) => {
  const dup = { hitAccount: 'a', next: 'b', switched: false, duplicate: true };
  const s = await setup(t, Array.from({ length: 5 }, () => ({ ...dup })));
  await Promise.all(Array.from({ length: 5 }, () => s.limit()));
  await until(() => s.handled.length === 5);
  await until(() => s.notes.length >= 1);
  await s.settle();
  assert.equal(s.spawned.length, 1);
  assert.ok(s.notes.length <= 2, `expected at most 2 notifications, got ${s.notes.length}`);
  assert.equal(s.notes[0][0], 'Claude chat continues');
  assert.equal(s.notes.filter((n) => n[0] === 'Claude chat continues').length, 1);
  assert.ok(s.notes.filter((n) => n[0] === 'Claude chat stopped').length <= 1);
});

test('wake ok on a duplicate (already switched): "continues on"', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: false, duplicate: true }]);
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.deepEqual(s.notes, [['Claude chat continues', '"Nike Board" continues on b.']]);
});

test('loop guard: the helper session id from its init event never starts another switch or wake', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }, { hitAccount: 'a', next: 'b', switched: true }]);
  await s.limit();
  await until(() => s.notes.length === 1);
  await s.limit(HELPER);
  await s.settle();
  assert.equal(s.handled.length, 1);
  assert.equal(s.notes.length, 1);
  assert.equal(s.spawned.length, 1);
});

test('wake fails (spawn error): switched names the chat, a duplicate names it too', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }], { behaviour: 'throw' });
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in "Nike Board".']]);
  const d = await setup(t, [{ hitAccount: 'a', next: 'b', switched: false, duplicate: true }], { behaviour: 'throw' });
  await d.limit();
  await until(() => d.notes.length === 1);
  assert.deepEqual(d.notes, [['Claude chat stopped', 'Type "continue" in "Nike Board".']]);
});

test('chat not in the registry: switched keeps today\'s text, a duplicate stays quiet (forged ids must not spam)', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }], { registry: [] });
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in the chat that stopped.']]);
  const d = await setup(t, [{ hitAccount: 'a', next: 'b', switched: false, duplicate: true }], { registry: [] });
  await d.limit();
  await until(() => d.handled.length === 1);
  await d.settle();
  assert.equal(d.notes.length, 0);
  assert.equal(d.spawned.length, 0);
});

test('mode unknown falls back to the notification without spawning', async (t) => {
  const s = await setup(t, [{ hitAccount: 'a', next: 'b', switched: true }], { mode: null });
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.equal(s.notes[0][1], 'Now on b (a hit its usage limit). Type "continue" in "Nike Board".');
  assert.equal(s.spawned.length, 0);
});

test('error and all-out texts are unchanged with the wake on', async (t) => {
  const s = await setup(t, [{ hitAccount: null, next: null, error: 'broken' }, { hitAccount: 'b', next: null, duplicate: false }, { hitAccount: 'a', next: null, duplicate: true }]);
  for (let i = 1; i <= 3; i++) { await s.limit(); await until(() => s.handled.length === i); await s.settle(); }
  assert.deepEqual(s.notes, [['Claude account switch failed', 'broken'], ['Claude accounts all out', 'Every Claude account is at its usage limit.']]);
  assert.equal(s.spawned.length, 0);
});
