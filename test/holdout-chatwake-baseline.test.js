// Verifier baseline: chat limit behaviour today (no wake). Must pass on the base commit and stay green.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until } from './codex-helpers.js';

async function setup(t, decisions) {
  const handled = [];
  const manager = { hasAccounts: () => true, recordRateLimit() {}, close() {}, handleLimit: async (a) => { handled.push(a); return decisions.shift(); } };
  const notes = [];
  let spawns = 0;
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    accounts: { manager, command: process.execPath, args: [], spawn: () => { spawns++; throw new Error('no spawn expected'); }, notify: (a, b) => notes.push([a, b]) },
  });
  t.after(() => srv.close());
  const limit = (sid) => req(srv.port, 'POST', '/hook', { body: { session_id: sid, hook_event_name: 'StopFailure', error: 'rate_limit' } });
  return { handled, notes, limit, spawns: () => spawns };
}

test('baseline: a chat limit with a next account that is already live is quiet; a switch names no chat; nothing is spawned', async (t) => {
  const s = await setup(t, [
    { hitAccount: 'a', next: 'b', switched: false, duplicate: true },
    { hitAccount: 'a', next: 'b', switched: true },
  ]);
  await s.limit('11111111-1111-4111-8111-111111111111');
  await until(() => s.handled.length === 1);
  await new Promise((r) => setTimeout(r, 80));
  assert.deepEqual(s.notes, []);
  await s.limit('22222222-2222-4222-8222-222222222222');
  await until(() => s.notes.length === 1);
  assert.deepEqual(s.notes, [['Claude account switched', 'Now on b (a hit its usage limit). Type "continue" in the chat that stopped.']]);
  assert.equal(s.spawns(), 0);
});

test('baseline: every chat StopFailure reaches handleLimit with no run account (one decision per hook)', async (t) => {
  const d = { hitAccount: 'a', next: null, duplicate: true };
  const s = await setup(t, [d, d, d]);
  for (const sid of ['s1', 's2', 's3']) await s.limit(sid);
  await until(() => s.handled.length === 3);
  assert.ok(s.handled.every((h) => h.runAccount === null && h.source === 'stopfailure'));
  assert.deepEqual(s.notes, []);
});
