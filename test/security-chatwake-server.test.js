// White-hat exploit tests (am-chat-autocontinue), server level: forged POST /hook StopFailure events against the chat wake.
// Each test FAILS on the current code. Fake manager, fake spawn, temp session registry, notification recorder only.
// Run from a copy of the repo with this file in test/ (imports are relative to test/).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until } from './codex-helpers.js';

const SID = '11111111-1111-4111-8111-111111111111';
const HELPER = '99999999-9999-4999-8999-999999999999';
const entry = { pid: process.pid, sessionId: SID, name: 'Nike Board', status: 'idle', statusUpdatedAt: 1 };
const resultOk = { type: 'user', message: { content: [{ type: 'tool_result', content: JSON.stringify({ success: true }) }] } };
// What the real manager returns for a chat hit inside its 2-minute duplicate window: next = the live login, no switch.
const DUP = { hitAccount: 'a', next: 'b', switched: false, duplicate: true };

async function setup(t, { delayMs = 0 } = {}) {
  const dir = tmp('am-sess-');
  fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify(entry));
  const handled = [];
  const manager = { hasAccounts: () => true, recordRateLimit() {}, close() {}, handleLimit: async (a) => { handled.push(a); return { ...DUP }; } };
  const notes = [];
  const spawned = [];
  const spawn = (command, argv) => {
    const c = new EventEmitter();
    c.pid = 7000 + spawned.length; c.stdout = new PassThrough(); c.stderr = new PassThrough(); c.stdin = new PassThrough();
    spawned.push({ command, argv });
    setTimeout(() => {
      // The chat takes the notice: its registry entry turns busy, then idle again.
      fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify({ ...entry, status: 'idle', statusUpdatedAt: Date.now() + 1000 }));
      c.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: HELPER })}\n${JSON.stringify(resultOk)}\n`);
      c.stdout.end();
      setImmediate(() => c.emit('close', 0));
    }, delayMs);
    return c;
  };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    accounts: { manager, command: 'fake-claude', args: [], spawn, killTree() {}, sessionsDir: dir, notify: (a, b) => notes.push([a, b]) },
  });
  t.after(() => srv.close());
  const hook = (session_id, extra) => req(srv.port, 'POST', '/hook', { body: { session_id, cwd: 'C:\\w\\repo', ...extra } });
  await hook(SID, { hook_event_name: 'UserPromptSubmit', permission_mode: 'bypassPermissions', prompt: 'x' });
  const limit = (id = SID) => hook(id, { hook_event_name: 'StopFailure', error: 'rate_limit' });
  const settle = (ms = 150) => new Promise((r) => setTimeout(r, ms));
  return { handled, notes, spawned, limit, settle };
}

// Every desktop notification is a PowerShell + WinForms process that lives ~12 s. Before this change a duplicate chat hit
// was quiet; now each forged duplicate StopFailure for a live chat (after one wake) raises a notification.
test('EXPLOIT notify flood: 20 forged duplicate StopFailures for a live chat raise at most a couple of notifications', async (t) => {
  const s = await setup(t);
  await s.limit();
  await until(() => s.notes.length === 1);
  assert.equal(s.spawned.length, 1);
  for (let i = 0; i < 20; i++) await s.limit();
  await until(() => s.handled.length === 21);
  await s.settle();
  assert.ok(s.notes.length <= 2, `one forged POST = one notification: ${s.notes.length} notifications, e.g. ${JSON.stringify(s.notes[1])}`);
});

// Coalesced callers share the in-flight wake's result, and each of them notifies on its own.
test('EXPLOIT notify flood: 20 concurrent forged StopFailures during one wake raise at most a couple of notifications', async (t) => {
  const s = await setup(t, { delayMs: 300 });
  await Promise.all(Array.from({ length: 21 }, () => s.limit()));
  await until(() => s.handled.length === 21);
  await until(() => s.notes.length >= 1);
  await s.settle(300);
  assert.equal(s.spawned.length, 1);
  assert.ok(s.notes.length <= 2, `${s.notes.length} notifications for one wake`);
});

// The dedupe map keeps the last 200 finished wakes, and a forged random id is recorded too: 200 forged ids push the real
// chat's record out, and the next forged StopFailure for it spawns another helper and wakes the chat again.
test('EXPLOIT dedupe bypass: 200 forged random ids do not let a live chat be woken twice inside the dedupe window', async (t) => {
  const s = await setup(t);
  await s.limit();
  await until(() => s.notes.length === 1);
  await s.limit(); // inside the window: refused ('woken recently')
  await until(() => s.handled.length === 2);
  await s.settle();
  assert.equal(s.spawned.length, 1, 'sanity: the second wake is deduped');
  for (let i = 0; i < 200; i += 20) await Promise.all(Array.from({ length: 20 }, () => s.limit(crypto.randomUUID())));
  await until(() => s.handled.length === 202);
  await s.settle();
  await s.limit();
  await until(() => s.handled.length === 203);
  await s.settle(300);
  assert.equal(s.spawned.length, 1, `the chat was woken ${s.spawned.length} times within the 10-minute dedupe window`);
});
