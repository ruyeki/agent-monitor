import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startServer } from '../src/server.js';
import { openStore } from '../src/store.js';
import { openUsage } from '../src/usage.js';
import * as engine from '../src/engine.js';
import { createCodex } from '../src/codex.js';
import { checkCodexConfig, CODEX_ROOT, HANDOFF, HANDOFF_PROFILE, ROLES } from '../src/codex-config.js';
import { req } from './holdout-helpers.js';
import { STUB, tmp, until, makeWorld, calls, readLog } from './codex-helpers.js';

const ok = (id = 'thr-1') => [{ type: 'thread.started', thread_id: id }, { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 7, reasoning_output_tokens: 2 } }];

async function setup(t, { steps = [{ lines: ok() }], enabled = true, repo, killTree } = {}) {
  const world = makeWorld();
  const dataDir = tmp();
  const store = openStore(dataDir);
  const usage = await openUsage({ dataDir, projectsDir: tmp('am-proj-') });
  const log = path.join(world.base, 'stub.log');
  const codex = createCodex({
    store, usage, enabled, command: process.execPath, args: [STUB], root: world.root, killTree,
    env: { ...process.env, AM_STUB_LOG: log, AM_STUB_CALLS: calls(steps) },
  });
  t.after(async () => { codex.close(); await usage.close(); store.close(); });
  const started = store.startRun({ title: 'Cx', repo: repo === undefined ? world.repo : repo, note: 'Spec C:\\Users\\r\\.claude\\fable-runs\\demo\\spec.md and C:\\Users\\r\\.claude\\fable-runs\\demo\\facts.md' });
  const id = started.run.id;
  const idle = () => until(() => !codex.running(id));
  return { world, store, usage, codex, log, id, idle, lines: () => readLog(log) };
}

const hit = { at: new Date().toISOString(), resetsAt: null, source: 'stopfailure' };

test('config: the pinned models have no astra, no ultra effort and no fast tier', () => {
  assert.deepEqual(checkCodexConfig(), []);
  assert.ok(checkCodexConfig({ handoff: { model: 'gpt-6-astra', effort: 'high' } }).length);
  assert.ok(checkCodexConfig({ roles: { x: { model: 'gpt-5.6-sol', effort: 'ultra' } } }).length);
  assert.ok(checkCodexConfig({ roles: { x: { model: 'gpt-5.6-sol', effort: 'high', tier: 'ultrafast' } } }).length);
  assert.ok(checkCodexConfig({ roles: { x: { model: 'gpt-5.6-sol', effort: 'fast' } } }).length);
  assert.equal(Object.keys(ROLES).length, 6);
});

test('config: CODEX_ROOT is the real absolute Windows path (escaped backslashes)', () => {
  assert.equal(CODEX_ROOT, 'C:\\Users\\ruyek\\Documents\\Persist-AI');
  assert.ok(path.win32.isAbsolute(CODEX_ROOT));
  if (process.platform === 'win32') assert.ok(path.isAbsolute(CODEX_ROOT));
});

test('trigger on an active run: hands over, spawns exec with exact args, prompt on stdin, saves the thread', async (t) => {
  const s = await setup(t, { steps: [{ lines: ok(), sleep: 500 }] });
  await s.codex.trigger(s.id, hit);
  await until(() => s.usage.codexTotals(s.id).length === 1); // the child is still running: a clean exit with the run active is escalated
  const [call] = s.lines();
  assert.deepEqual(call.argv, [
    'exec', '--json', '-p', HANDOFF_PROFILE, '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, '--disable', 'fast_mode', '-C', s.world.repo, '-',
  ]);
  const joined = call.argv.join(' ');
  assert.doesNotMatch(joined, /astra|ultra|tier/i);
  assert.equal(fs.realpathSync(call.cwd), s.world.repo);
  assert.match(call.stdin, /run "cx"/);
  assert.match(call.stdin, /frame \(/);
  assert.match(call.stdin, /get_run/);
  assert.match(call.stdin, /fable-runs\\demo\\spec\.md/);
  assert.match(call.stdin, /fable-runs\\demo\\facts\.md/);
  assert.match(call.stdin, /git status/);
  assert.match(call.stdin, /Never push/);
  assert.ok(!call.argv.some((a) => a.includes('Agent Monitor run')), 'the prompt is never an argument');

  const run = s.store.getRun(s.id);
  assert.equal(run.provider, 'codex');
  assert.equal(run.codex_thread_id, 'thr-1');
  assert.equal(run.limit_source, 'stopfailure');
  assert.equal(s.store.sessionRun('thr-1').id, s.id);
  const d = s.store.detail(s.id);
  assert.ok(d.visits.filter((v) => !v.leftAt).every((v) => v.provider === 'codex'));
  assert.equal(d.run.provider, 'codex');
  assert.equal(d.run.status, 'active');
  const [row] = s.usage.codexTotals(s.id);
  assert.deepEqual(row, { model: HANDOFF.model, input: 70, output: 7, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 30 });
});

test('a clean exit while the run is still active goes to Decision (no silent stall)', async (t) => {
  const s = await setup(t, { steps: [{ lines: [{ type: 'thread.started', thread_id: 'thr-s' }] }] });
  await s.codex.trigger(s.id, hit);
  await s.idle();
  const run = s.store.getRun(s.id);
  assert.equal(run.status, 'waiting');
  assert.equal(run.stage, 'decision');
  assert.match(run.ask, /ended its turn but the run is still at frame/);
});

test('a clean exit after the run reached a gate does not escalate', async (t) => {
  const s = await setup(t, { steps: [{ lines: ok('thr-g'), sleep: 400 }] });
  await s.codex.trigger(s.id, hit);
  await until(() => s.store.getRun(s.id).codex_thread_id === 'thr-g');
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' });
  await s.idle();
  const run = s.store.getRun(s.id);
  assert.equal(run.status, 'waiting');
  assert.equal(run.stage, 'gate1');
  assert.doesNotMatch(String(run.ask), /ended its turn/);
});

test('an answered gate while the child runs resumes on a clean exit and does not escalate', async (t) => {
  const s = await setup(t, { steps: [{ lines: ok('thr-p'), sleep: 500 }, { lines: ok('thr-p'), sleep: 500 }] });
  await s.codex.trigger(s.id, hit);
  await until(() => s.store.getRun(s.id).codex_thread_id === 'thr-p');
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' });
  s.store.respond(s.id, { action: 'Agree spec' });
  await s.codex.resume(s.id);
  await until(() => s.lines().length === 2, 8000);
  assert.equal(s.lines()[1].argv[3], 'resume');
  const run = s.store.getRun(s.id);
  assert.equal(run.status, 'active');
  assert.doesNotMatch(String(run.ask), /ended its turn/);
});

test('a run hands over at most once', async (t) => {
  const s = await setup(t);
  await Promise.all([s.codex.trigger(s.id, hit), s.codex.trigger(s.id, hit)]);
  await s.codex.trigger(s.id, hit);
  await s.idle();
  assert.equal(s.lines().length, 1);
});

test('trigger fills the reset time of an already marked run without a second hand-off', async (t) => {
  const s = await setup(t);
  await s.codex.trigger(s.id, hit);
  await s.idle();
  await s.codex.trigger(s.id, { at: hit.at, resetsAt: 1791655200, source: 'transcript' });
  assert.equal(s.store.getRun(s.id).resets_at, new Date(1791655200 * 1000).toISOString());
  assert.equal(s.store.getRun(s.id).limit_source, 'stopfailure');
  assert.equal(s.lines().length, 1);
});

test('hand-off off: the limit is recorded and nothing starts', async (t) => {
  const s = await setup(t, { enabled: false });
  await s.codex.trigger(s.id, hit);
  assert.equal(s.lines().length, 0);
  const run = s.store.getRun(s.id);
  assert.ok(run.limit_at);
  assert.notEqual(run.provider, 'codex');
  assert.match(run.note, /Codex hand-off is off/);
});

test('a waiting run is handed over but starts only when Ryan answers (fresh, with the answer)', async (t) => {
  const s = await setup(t);
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' }); // -> gate1
  assert.equal(s.store.getRun(s.id).status, 'waiting');
  await s.codex.trigger(s.id, hit);
  assert.equal(s.store.getRun(s.id).provider, 'codex');
  assert.equal(s.lines().length, 0);
  s.store.respond(s.id, { action: 'Agree spec', text: 'go' });
  await s.codex.resume(s.id);
  await s.idle();
  const [call] = s.lines();
  assert.equal(call.argv[0], 'exec');
  assert.ok(call.argv.includes('-C'));
  assert.match(call.stdin, /Ryan answered at gate1: Agree spec — go\./);
});

test('resume: exec resume with the saved thread id, answer on stdin, no -C and no astra', async (t) => {
  const s = await setup(t, { steps: [{ lines: ok('thr-9') }, { lines: [] }] });
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' });
  await s.codex.trigger(s.id, hit); // waiting: handed over only
  s.store.setCodexThread(s.id, 'thr-9');
  s.store.respond(s.id, { action: 'Agree spec' });
  await s.codex.resume(s.id);
  await s.idle();
  const [call] = s.lines();
  assert.deepEqual(call.argv, [
    'exec', '-p', HANDOFF_PROFILE, 'resume', '--json', '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, '--disable', 'fast_mode', 'thr-9', '-',
  ]);
  assert.doesNotMatch(call.argv.join(' '), /astra|ultra|tier/i);
  assert.equal(call.stdin, 'Ryan answered at gate1: Agree spec. Call get_run with run "cx" and continue from the current node.');
});

test('an answer while the child still runs waits and resumes when it exits', async (t) => {
  const s = await setup(t, { steps: [{ lines: ok('thr-2'), sleep: 600 }, { lines: [] }] });
  await s.codex.trigger(s.id, hit);
  await until(() => s.store.getRun(s.id).codex_thread_id === 'thr-2');
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' });
  s.store.respond(s.id, { action: 'Agree spec' });
  await s.codex.resume(s.id);
  assert.equal(s.lines().length, 1);
  await until(() => s.lines().length === 2, 8000);
  assert.equal(s.lines()[1].argv[3], 'resume');
});

test('cwd: outside the root, not a git tree, ".." and junction escapes are refused, with a Decision and no spawn', async (t) => {
  const link = (w) => { const l = path.join(w.root, 'link'); fs.symlinkSync(w.outside, l, 'junction'); return l; };
  const cases = {
    'outside the root': (w) => w.outside,
    'not a git work tree': (w) => w.plain,
    'dot-dot escape': (w) => path.join(w.root, 'repo', '..', '..', 'outside'),
    'junction escape': (w) => link(w),
    'missing folder': (w) => path.join(w.root, 'nope'),
  };
  for (const [name, pick] of Object.entries(cases)) {
    const s = await setup(t, { repo: null });
    const dir = pick(s.world);
    s.store.noteCwd(s.id, dir);
    await s.codex.trigger(s.id, hit);
    assert.equal(s.lines().length, 0, name);
    const run = s.store.getRun(s.id);
    assert.equal(run.status, 'waiting', name);
    assert.equal(run.stage, 'decision', name);
    assert.match(run.ask, /Codex hand-off failed: no git work tree/, name);
  }
});

test('cwd: repo may be a bare name under the root; a recorded cwd is the fallback', async (t) => {
  const a = await setup(t, { repo: 'repo' });
  await a.codex.trigger(a.id, hit);
  await a.idle();
  assert.equal(fs.realpathSync(a.lines()[0].cwd), a.world.repo);

  const b = await setup(t, { repo: path.join('x', 'no-such') });
  b.store.noteCwd(b.id, b.world.repo);
  await b.codex.trigger(b.id, hit);
  await b.idle();
  assert.equal(fs.realpathSync(b.lines()[0].cwd), b.world.repo);
});

test('Codex usage limit: error + turn.failed park the run at Decision with a note, and nothing retries', async (t) => {
  const msg = "You've hit your usage limit. Try again later.";
  const s = await setup(t, { steps: [{ lines: [...ok(), { type: 'error', message: msg }, { type: 'turn.failed', error: { message: msg } }], exit: 1 }] });
  await s.codex.trigger(s.id, hit);
  await s.idle();
  const run = s.store.getRun(s.id);
  assert.equal(run.status, 'waiting');
  assert.equal(run.stage, 'decision');
  assert.equal(run.ask, `Codex usage limit hit: ${msg}`);
  assert.equal(run.provider, 'codex');
  assert.ok(s.store.detail(s.id).visits.some((v) => v.outcome === 'escalated'));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(s.lines().length, 1);
});

test('other Codex failures go to Decision with the message', async (t) => {
  const s = await setup(t, { steps: [{ lines: [{ type: 'turn.failed', error: { message: 'model exploded' } }], exit: 1 }] });
  await s.codex.trigger(s.id, hit);
  await s.idle();
  const run = s.store.getRun(s.id);
  assert.equal(run.stage, 'decision');
  assert.equal(run.ask, 'Codex failed: model exploded');
});

test('a non-zero exit with no event goes to Decision, with the last error when there was one', async (t) => {
  const a = await setup(t, { steps: [{ lines: ['not json', { type: 'error', message: 'stream hiccup' }], exit: 3 }] });
  await a.codex.trigger(a.id, hit);
  await a.idle();
  assert.equal(a.store.getRun(a.id).ask, 'Codex exited with code 3: stream hiccup');
  const b = await setup(t, { steps: [{ lines: [], exit: 2 }] });
  await b.codex.trigger(b.id, hit);
  await b.idle();
  assert.equal(b.store.getRun(b.id).ask, 'Codex exited with code 2');
});

test('a missing codex binary goes to Decision', async (t) => {
  const world = makeWorld();
  const dataDir = tmp();
  const store = openStore(dataDir);
  const usage = await openUsage({ dataDir, projectsDir: tmp('am-proj-') });
  const codex = createCodex({ store, usage, enabled: true, command: path.join(world.base, 'no-such-codex'), root: world.root });
  t.after(async () => { codex.close(); await usage.close(); store.close(); });
  const { run } = store.startRun({ title: 'Cx', repo: world.repo });
  await codex.trigger(run.id, hit);
  await until(() => store.getRun(run.id).stage === 'decision');
  assert.match(store.getRun(run.id).ask, /^Codex could not start: /);
});

test('stop kills the child tree, the exit then changes nothing, and a pending answer is dropped', async (t) => {
  const killed = [];
  const s = await setup(t, { steps: [{ lines: ok('thr-3'), sleep: 30000, exit: 1 }], killTree: (pid) => { killed.push(pid); process.kill(pid); } });
  await s.codex.trigger(s.id, hit);
  await until(() => s.store.getRun(s.id).codex_thread_id === 'thr-3');
  assert.equal(s.codex.running(s.id), true);
  s.store.stopRun(s.id);
  s.codex.stop(s.id);
  assert.equal(killed.length, 1);
  assert.equal(s.codex.running(s.id), false);
  await new Promise((r) => setTimeout(r, 300));
  const run = s.store.getRun(s.id);
  assert.equal(run.status, 'stopped');
  assert.equal(s.lines().length, 1);
});

test('schema migration 2 -> 3 on a v2 database keeps data and adds the Codex columns', (t) => {
  const dir = tmp();
  const first = openStore(dir);
  const { run } = first.startRun({ title: 'Old' });
  first.close();
  const NEW = ['provider', 'codex_thread_id', 'limit_at', 'resets_at', 'limit_source', 'cwds_json'];
  const raw = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  for (const c of NEW) raw.exec(`ALTER TABLE runs DROP COLUMN ${c}`);
  raw.exec('ALTER TABLE node_visits DROP COLUMN provider; ALTER TABLE agents DROP COLUMN provider; PRAGMA user_version = 2');
  raw.close();
  const store = openStore(dir);
  t.after(() => store.close());
  const check = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  const cols = (table) => check.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  assert.ok(NEW.every((c) => cols('runs').includes(c)));
  assert.ok(cols('node_visits').includes('provider') && cols('agents').includes('provider'));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 3);
  check.close();
  const old = store.summary(store.getRun(run.id));
  assert.equal(old.provider, 'claude');
  assert.equal(old.limitAt, null);
  assert.equal(store.detail(run.id).visits[0].provider, 'claude');
});

test('store: noteCwd is distinct, most recent first, capped at 5 and written only on change', (t) => {
  const store = openStore(tmp());
  t.after(() => store.close());
  const { run } = store.startRun({ title: 'N' });
  const list = () => JSON.parse(store.getRun(run.id).cwds_json);
  for (const c of ['/a', '/b', '/c', '/d', '/e', '/f']) store.noteCwd(run.id, c);
  assert.deepEqual(list(), ['/f', '/e', '/d', '/c', '/b']);
  store.noteCwd(run.id, '/d');
  assert.deepEqual(list(), ['/d', '/f', '/e', '/c', '/b']);
  store.noteCwd(run.id, 'x'.repeat(1001));
  store.noteCwd(run.id, 42);
  assert.equal(list().length, 5);
  assert.equal(store.noteCwd('nope', '/z'), undefined);
});

test('store: escalate needs a live run; a workflow without a decision gate only logs', (t) => {
  const store = openStore(tmp());
  t.after(() => store.close());
  const { run } = store.startRun({ title: 'E' });
  const r = store.escalate(run.id, 'because');
  assert.equal(r.run.stage, 'decision');
  assert.equal(r.run.ask, 'because');
  store.stopRun(run.id);
  assert.match(store.escalate(run.id, 'late').error, /already stopped/);
  assert.ok(store.escalate('missing', 'x').notFound);

  const wf = { ...store.version(1), loop: { maxRounds: 5, decision: 'none' } };
  const out = engine.escalate(wf, { active: ['frame'], joins: {}, round: 0, status: 'active', verdict: null, ask: null }, 'just a note');
  assert.equal(out.ok, true);
  assert.equal(out.noGate, true);
  assert.deepEqual(out.entered, []);
});

test('closing the server while a Codex child still runs raises nothing late (no store or usage call after close)', async (t) => {
  const errors = [];
  const onErr = (e) => errors.push(e);
  process.on('uncaughtException', onErr);
  process.on('unhandledRejection', onErr);
  t.after(() => { process.off('uncaughtException', onErr); process.off('unhandledRejection', onErr); });
  const world = makeWorld();
  const log = path.join(world.base, 'stub.log');
  const steps = [{ lines: [{ type: 'thread.started', thread_id: 'thr-late' }], sleep: 600 }];
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: { command: process.execPath, args: [STUB], root: world.root, env: { ...process.env, AM_STUB_LOG: log, AM_STUB_CALLS: calls(steps) } },
  });
  const id = srv.store.startRun({ title: 'Late', repo: world.repo }).run.id;
  // The stub starts, prints its thread event and is still running (then exits late) when the server closes.
  srv.store.linkSession('sess-late', id);
  await req(srv.port, 'POST', '/hook', { body: { session_id: 'sess-late', hook_event_name: 'StopFailure', error: 'rate_limit' } });
  await until(() => readLog(log).length === 1);
  await srv.close();
  await new Promise((r) => setTimeout(r, 1200));
  assert.deepEqual(errors, []);
});
