// What the code does today (base commit): Codex hand-off without the accounts option, bin usage, hook fail-open.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { boot, load, tmp, until, sleep, REPO } from './holdout-accounts-helpers.js';

test('no accounts option: a rate_limit on a tracked run hands it to Codex, once', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const id = await app.startRun('Base 1', { repo: 'repoA' });
  await app.link('b-sess-1', id);
  assert.equal((await app.limit('b-sess-1')).status, 200);
  await app.limit('b-sess-1'); await app.limit('b-sess-1');
  assert.ok(await until(() => app.codexCalls()[0]));
  await sleep(1500);
  assert.equal(app.codexCalls().length, 1);
  const d = await app.detail(id);
  assert.equal(d.run.provider, 'codex');
  assert.equal(d.run.limitSource, 'stopfailure');
  assert.match(JSON.stringify(d), /Handed over to Codex/);
});

test('a chat (unlinked session) rate_limit is only answered, nothing is started', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const r = await app.limit('b-chat');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {});
  await sleep(1000);
  assert.equal(app.codexCalls().length, 0);
});

test('other StopFailure errors never mark or hand over a run', async (t) => {
  const app = await boot();
  t.after(() => app.close());
  const id = await app.startRun('Base 2', { repo: 'repoA' });
  await app.link('b-sess-2', id);
  for (const error of ['overloaded', 'authentication_failed', 'server_error', 'Rate_Limit']) await app.limit('b-sess-2', { error });
  await sleep(1000);
  const d = await app.detail(id);
  assert.ok(!d.run.limitAt);
  assert.equal(app.codexCalls().length, 0);
});

test('without the codex option a limit hit is recorded but nothing is spawned', async (t) => {
  const app = await boot({ codex: false });
  t.after(() => app.close());
  const id = await app.startRun('Base 3', { repo: 'repoA' });
  await app.link('b-sess-3', id);
  await app.limit('b-sess-3');
  await sleep(800);
  const d = await app.detail(id);
  assert.ok(d.run.limitAt, 'limit recorded');
  assert.notEqual(d.run.provider, 'codex');
});

test('bin: unknown or incomplete commands print usage and exit 2', () => {
  for (const args of [[], ['nope'], ['wait'], ['hook']]) {
    const r = spawnSync(process.execPath, [path.join(REPO, 'bin', 'agent-monitor.js'), ...args], { encoding: 'utf8', timeout: 15000, windowsHide: true });
    assert.equal(r.status, 2, `args ${JSON.stringify(args)}`);
    assert.match(r.stderr, /Usage: agent-monitor/);
  }
});

test('hooks: StopFailure rate_limit callback carries run id, time, reset and source (the onLimit contract)', async () => {
  const { openStore } = await load('src/store.js');
  const { createHooks } = await load('src/hooks.js');
  const limits = [];
  const store = openStore(tmp('amv-b-'));
  const hooks = createHooks(store, { projectsDir: tmp('amv-bp-'), port: 4747, defer: (fn) => fn(), clock: () => Date.parse('2026-11-02T10:00:00Z'), onLimit: (i) => limits.push(i) });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  hooks.handle({ session_id: 'cs', cwd: 'C:\\w\\repo', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: 1791655200 } });
  assert.deepEqual(limits, [{ runId: run.id, at: '2026-11-02T10:00:00.000Z', resetsAt: new Date(1791655200 * 1000).toISOString(), source: 'stopfailure' }]);
  assert.deepEqual(hooks.handle({ session_id: 'unlinked', hook_event_name: 'StopFailure', error: 'rate_limit' }), {});
  assert.equal(limits.length, 1);
  store.close();
});

test('store: markLimit is atomic (first hit only), and handOver switches the provider', async () => {
  const { openStore } = await load('src/store.js');
  const store = openStore(tmp('amv-bs-'));
  const { run } = store.startRun({ title: 'R' });
  assert.equal(store.markLimit(run.id, { at: new Date().toISOString(), source: 'stopfailure' }), true);
  assert.equal(store.markLimit(run.id, { at: new Date().toISOString(), source: 'stopfailure' }), false);
  store.handOver(run.id);
  assert.equal(store.getRun(run.id).provider, 'codex');
  assert.equal(store.markLimit(run.id, { source: 'x' }), false);
  store.close();
});
