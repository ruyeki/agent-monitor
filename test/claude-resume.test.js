// Claude account rotation in front of the Codex hand-off: the limit coordinator, the headless `claude --resume` child and its stream.
// The manager is a fake that follows the W1 contract; `claude` and `codex` are stubs; nothing real is called and no notification is shown.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../src/server.js';
import { createClaudeResume } from '../src/claude-resume.js';
import { req } from './holdout-helpers.js';
import { tmp, until, makeWorld, calls, readLog } from './codex-helpers.js';

const CLAUDE_STUB = path.join(import.meta.dirname, 'fixtures', 'claude-stub.mjs');
const RESETS = 1791655200;
const init = (sid) => ({ type: 'system', subtype: 'init', session_id: sid });
const rl = (status = 'allowed') => ({ type: 'rate_limit_event', rate_limit_info: { status, resetsAt: RESETS, rateLimitType: 'five_hour' }, session_id: 'x' });

function fakeManager({ decisions = [], has = true } = {}) {
  const m = {
    handled: [], recorded: [], closed: 0,
    hasAccounts: () => has,
    handleLimit: async (a) => { m.handled.push(a); const d = decisions.shift() ?? { next: null }; if (d instanceof Error) throw d; return d; },
    recordRateLimit: (name, info) => { m.recorded.push([name, info]); },
    close: () => { m.closed += 1; },
  };
  return m;
}

function fakeCodexChild() {
  const c = new EventEmitter();
  c.pid = 0; c.stdin = { on() {}, end() {} }; c.stderr = { resume() {} };
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  setTimeout(() => { c.stdout.emit('end'); c.emit('close', 0); }, 10);
  return c;
}

// A run linked to session 'orig' whose transcript lives in projectsDir; `cwd` is the folder the transcript names.
async function setup(t, { steps = [{ lines: [init('hl-1'), rl()], sleep: 1500 }], decisions = [{ hitAccount: 'a', next: 'b' }], manager, noAccounts = false, transcriptCwd = 'own', hookCwd = 'own' } = {}) {
  const world = makeWorld();
  const projectsDir = tmp('am-proj-');
  const work = fs.realpathSync(tmp('am-work-'));
  const other = fs.realpathSync(tmp('am-other-'));
  const transcript = path.join(projectsDir, 'proj', 'orig.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, `${JSON.stringify({ type: 'summary' })}\n${transcriptCwd ? JSON.stringify({ cwd: transcriptCwd === 'own' ? work : transcriptCwd }) : ''}\n`);
  const log = path.join(world.base, 'stub.log');
  const mgr = manager ?? fakeManager({ decisions });
  const notes = [];
  const codexSpawned = [];
  const env = { ...process.env, AM_STUB_LOG: log, AM_STUB_CALLS: calls(steps), CLAUDE_CODE_OAUTH_TOKEN: 'x', ANTHROPIC_API_KEY: 'y', ANTHROPIC_AUTH_TOKEN: 'z' };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir, webDir: path.join(tmp('am-web-'), 'nope'), usageIntervalMs: 100,
    codex: { command: process.execPath, root: world.root, env: process.env, spawn: (cmd, argv, o) => { codexSpawned.push({ cmd, argv, cwd: o.cwd }); return fakeCodexChild(); } },
    accounts: noAccounts ? null : { manager: mgr, command: process.execPath, args: [CLAUDE_STUB], env, notify: (title, text) => notes.push([title, text]) },
  });
  let shut;
  const close = () => (shut ??= srv.close());
  t.after(close);
  const id = srv.store.startRun({ title: 'Rot', repo: world.repo }).run.id;
  srv.store.linkSession('orig', id);
  const post = (body) => req(srv.port, 'POST', '/hook', { body });
  // Any event of the main session: creates its agent row, records the transcript, cwd and permission mode.
  await post({ session_id: 'orig', hook_event_name: 'Notification', message: 'hi', transcript_path: transcript, cwd: hookCwd === 'own' ? work : other, permission_mode: 'acceptEdits' });
  const limit = (extra = {}) => post({ session_id: 'orig', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: RESETS }, ...extra });
  return {
    srv, close, store: srv.store, id, world, work, other, transcript, projectsDir, mgr, notes, codexSpawned, post, limit, log, lines: () => readLog(log),
    respond: (action, text = '') => req(srv.port, 'POST', `/api/runs/${id}/respond`, { body: { action, text } }),
    timeline: () => srv.store.detail(id).timeline.map((e) => e.note),
  };
}

test('a limit rotates to the next account before Codex: exact argv (fork, mode), prompt on stdin, cwd from the transcript, session saved from init', async (t) => {
  const s = await setup(t, { transcriptCwd: 'own', hookCwd: 'other' });
  await s.limit();
  await until(() => s.lines().length === 1 && s.store.runAccount(s.id)?.session_id === 'hl-1');
  assert.deepEqual(s.mgr.handled, [{ runAccount: null, at: s.mgr.handled[0].at, resetsAt: new Date(RESETS * 1000).toISOString(), source: 'stopfailure' }]);
  const [call] = s.lines();
  assert.deepEqual(call.argv, ['--resume', 'orig', '--fork-session', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.equal(fs.realpathSync(call.cwd), s.work, 'cwd from the transcript, not the hook cwd');
  assert.match(call.stdin, /run "rot"/);
  assert.match(call.stdin, /Rot/);
  assert.match(call.stdin, /account a hit its usage limit; account b took over/);
  assert.match(call.stdin, /get_run/);
  assert.match(call.stdin, /complete_stage/);
  assert.match(call.stdin, /never push/i);
  assert.ok(!call.argv.some((a) => a.includes('Agent Monitor run')), 'the prompt is never an argument');
  assert.deepEqual(call.env, { token: false, apiKey: false, authToken: false, safe: '1' });

  const run = s.store.getRun(s.id);
  assert.equal(run.provider ?? 'claude', 'claude');
  assert.equal(run.limit_at, null);
  assert.equal(s.store.runAccount(s.id).account, 'b');
  assert.equal(s.store.summary(run).claudeAccount, 'b');
  assert.equal(s.store.sessionRun('hl-1').id, s.id);
  assert.ok(s.timeline().includes('Claude account a hit its usage limit; resumed on account b'));
  assert.deepEqual(s.notes, [['Claude account switched', 'Run rot continues headless on account b. Other chats that stopped: type "continue".']]);
  assert.equal(s.codexSpawned.length, 0);
  await until(() => s.mgr.recorded.length);
  assert.deepEqual(s.mgr.recorded, [['b', { status: 'allowed', resetsAt: RESETS, rateLimitType: 'five_hour' }]]);
});

test('the cwd falls back to the run folders; a missing folder escalates and spawns nothing', async (t) => {
  const s = await setup(t, { transcriptCwd: null, hookCwd: 'own' });
  await s.limit();
  await until(() => s.lines().length === 1);
  assert.equal(fs.realpathSync(s.lines()[0].cwd), s.work);

  const bad = await setup(t, { transcriptCwd: path.join(tmp('am-gone-'), 'nope'), hookCwd: 'other' });
  bad.store.noteCwd(bad.id, path.join(tmp('am-gone2-'), 'nope2')); // newest folder is gone too
  await bad.limit();
  await until(() => bad.store.getRun(bad.id).status === 'waiting');
  assert.match(bad.store.getRun(bad.id).ask, /Claude resume failed: working folder .* is not a directory/);
  assert.equal(bad.lines().length, 0);
});

test('the permission mode comes from the stopped session; an unknown mode falls back to default', async (t) => {
  const s = await setup(t);
  await s.post({ session_id: 'orig', hook_event_name: 'Notification', message: 'x', permission_mode: 'dontAsk' });
  assert.equal(s.store.sessionMode('orig'), 'acceptEdits', 'a mode outside the allowlist is not recorded');
  const plain = await setup(t);
  plain.store.noteMode('orig', 'plan');
  await plain.limit();
  await until(() => plain.lines().length === 1);
  assert.equal(plain.lines()[0].argv.at(-1), 'plan');
});

test('a rejected rate_limit_event rotates again from the headless session, with the run account as the hit account', async (t) => {
  const s = await setup(t, {
    steps: [{ lines: [init('hl-1'), rl('rejected')], sleep: 5000 }, { lines: [init('hl-2'), rl()], sleep: 1500 }],
    decisions: [{ hitAccount: 'a', next: 'b' }, { hitAccount: 'b', next: 'c' }],
  });
  await s.limit();
  await until(() => s.lines().length === 2);
  assert.equal(s.mgr.handled[1].runAccount, 'b');
  assert.equal(s.mgr.handled[1].source, 'headless');
  assert.equal(s.mgr.handled[1].resetsAt, RESETS);
  assert.deepEqual(s.lines()[1].argv.slice(0, 4), ['--resume', 'hl-1', '--fork-session', '-p'], 'forks the headless session again');
  assert.match(s.lines()[1].stdin, /account b hit its usage limit; account c took over/);
  await until(() => s.store.runAccount(s.id)?.session_id === 'hl-2');
  assert.equal(s.store.runAccount(s.id).account, 'c');
  assert.equal(s.store.getRun(s.id).status, 'active', 'the rejected child is stopped, not escalated');
  assert.equal(s.codexSpawned.length, 0);
  assert.equal(s.notes.length, 2);
});

test('a hit from before the switch (at <= resumed_at) is ignored', async (t) => {
  const s = await setup(t, { steps: [{ lines: [init('hl-1')], sleep: 3000 }] });
  await s.limit();
  await until(() => s.store.runAccount(s.id)?.session_id === 'hl-1');
  const line = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'limit-line.jsonl'), 'utf8')
    .replace('__SESSION__', 'orig').replace('__TS__', new Date(Date.now() - 60_000).toISOString()).replace('"agentId":"__AGENT__",', '');
  fs.appendFileSync(path.join(s.projectsDir, 'proj', 'old.jsonl'), line);
  await new Promise((r) => setTimeout(r, 600)); // several scans (100 ms each)
  assert.equal(s.mgr.handled.length, 1);
  assert.equal(s.store.getRun(s.id).limit_at, null);
  assert.equal(s.codexSpawned.length, 0);
});

test('a transcript hit goes through the same coordinator', async (t) => {
  const s = await setup(t);
  const line = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'limit-line.jsonl'), 'utf8')
    .replace('__SESSION__', 'orig').replace('__TS__', new Date().toISOString()).replace('"agentId":"__AGENT__",', '');
  fs.appendFileSync(path.join(s.projectsDir, 'proj', 'orig.jsonl'), line);
  await until(() => s.lines().length === 1);
  assert.equal(s.mgr.handled[0].source, 'transcript');
  assert.equal(s.store.runAccount(s.id).account, 'b');
});

test('Codex only when no account is left, the switch fails or throws; no manager accounts or no option = today', async (t) => {
  const cases = {
    'next null': [{ next: null, hitAccount: 'a' }, /All Claude accounts are out of usage; handing over to Codex/],
    'error': [{ next: null, error: 'swap broke' }, /Account switch failed: swap broke; handing over to Codex/],
    'throws': [new Error('boom'), /Account switch failed: boom; handing over to Codex/],
  };
  for (const [name, [decision, note]] of Object.entries(cases)) {
    const s = await setup(t, { decisions: [decision] });
    await s.limit();
    await until(() => s.codexSpawned.length === 1);
    assert.equal(s.codexSpawned.length, 1, name);
    assert.equal(s.lines().length, 0, name);
    assert.equal(s.store.getRun(s.id).provider, 'codex', name);
    assert.ok(s.timeline().some((n) => note.test(n)), name);
    assert.equal(s.store.getRun(s.id).limit_source, 'stopfailure', name);
  }
  for (const opts of [{ noAccounts: true }, { manager: fakeManager({ has: false }) }]) {
    const s = await setup(t, opts);
    await s.limit();
    await until(() => s.codexSpawned.length === 1);
    assert.equal(s.codexSpawned.length, 1);
    assert.equal(s.lines().length, 0);
    assert.equal(s.store.getRun(s.id).provider, 'codex');
    assert.equal(s.store.runAccount(s.id), null);
  }
});

test('a second hit on the same run does nothing (markLimit decides once)', async (t) => {
  const s = await setup(t, { decisions: [{ next: null }, { next: null }] });
  await s.limit();
  await s.limit();
  await until(() => s.codexSpawned.length === 1);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(s.mgr.handled.length, 1);
  assert.equal(s.codexSpawned.length, 1);
});

test('a waiting run launches on Ryan\'s answer (fork + answer line); a later answer resumes the saved session without fork', async (t) => {
  const s = await setup(t, { steps: [{ lines: [init('hl-1')], sleep: 150 }, { lines: [init('hl-1')], sleep: 150 }] });
  s.store.completeStage(s.id, { stage: 'frame', outcome: 'done' }); // -> gate1
  assert.equal(s.store.getRun(s.id).status, 'waiting');
  await s.limit();
  await until(() => s.store.runAccount(s.id)?.account === 'b');
  assert.equal(s.lines().length, 0, 'a waiting run does not launch');
  assert.ok(s.timeline().includes('Claude account a hit its usage limit; resumed on account b'));

  await s.respond('Agree spec', 'go');
  await until(() => s.lines().length === 1);
  const [first] = s.lines();
  assert.deepEqual(first.argv.slice(0, 3), ['--resume', 'orig', '--fork-session']);
  assert.match(first.stdin, /Ryan answered at gate1: Agree spec - go\./);
  assert.match(first.stdin, /get_run/);
  await until(() => s.store.runAccount(s.id)?.session_id === 'hl-1');
  await until(() => s.store.getRun(s.id).status === 'waiting' && s.store.getRun(s.id).stage === 'decision'); // clean exit while active: escalated

  await s.respond('Resume', 'again');
  await until(() => s.lines().length === 2);
  const second = s.lines()[1];
  assert.deepEqual(second.argv, ['--resume', 'hl-1', '-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']);
  assert.equal(second.stdin, 'Ryan answered at decision: Resume - again. Call get_run with run "rot" and continue from the current node.');
});

test('escalations: non-zero exit names the account and last error; a clean exit with the run still active; no session', async (t) => {
  const a = await setup(t, { steps: [{ lines: [init('hl-1'), { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'it broke' }], exit: 3 }] });
  await a.limit();
  await until(() => a.store.getRun(a.id).status === 'waiting');
  assert.equal(a.store.getRun(a.id).ask, 'Claude (account b) exited with code 3: it broke');

  const b = await setup(t, { steps: [{ lines: [init('hl-1')] }] });
  await b.limit();
  await until(() => b.store.getRun(b.id).status === 'waiting');
  assert.match(b.store.getRun(b.id).ask, /Claude ended its turn but the run is still at frame/);

  const c = await setup(t);
  c.srv.store.updateAgent('main:orig', { type: 'other' }); // no main session known
  await c.limit();
  await until(() => c.store.getRun(c.id).status === 'waiting');
  assert.match(c.store.getRun(c.id).ask, /Claude resume failed: no Claude session known/);
  assert.equal(c.lines().length, 0);
});

test('Stop kills the headless child and an answer does not restart it; close closes the manager', async (t) => {
  const s = await setup(t, { steps: [{ lines: [init('hl-1')], sleep: 5000 }] });
  await s.limit();
  await until(() => s.store.runAccount(s.id)?.session_id === 'hl-1');
  const r = await req(s.srv.port, 'POST', `/api/runs/${s.id}/stop`, { body: {} });
  assert.equal(r.status, 200);
  await new Promise((res) => setTimeout(res, 300));
  assert.equal(s.store.getRun(s.id).status, 'stopped');
  assert.equal(s.lines().length, 1);
  await s.close();
  assert.equal(s.mgr.closed, 1);
});

test('stop then start while an older launch still checks its folder: the newer child stays tracked and killable', async (t) => {
  const dir = tmp('am-cwd-');
  const real = fs.promises.stat;
  let release; const gate = new Promise((r) => { release = r; });
  let n = 0;
  fs.promises.stat = async (...a) => { if (n++ === 0) await gate; return real(...a); };
  t.after(() => { fs.promises.stat = real; });
  const store = {
    getRun: (id) => ({ id, provider: 'claude', status: 'active', title: 'T', cwds_json: JSON.stringify([dir]) }),
    runAccount: () => ({ account: 'b', hit_account: 'a', session_id: null }),
    latestMainSession: () => ({ session_id: 's1', transcript_path: null }),
    getAgent: () => null, sessionMode: () => 'plan', escalate() {}, setClaudeSession() {}, noteMode() {}, summary: () => ({ active: [] }),
  };
  const killed = []; const spawned = [];
  const cr = createClaudeResume({
    store, projectsDir: tmp('am-proj-'), command: 'claude', env: {}, killTree: (pid) => killed.push(pid),
    spawn: () => { const c = fakeCodexChild(); c.pid = 4242 + spawned.length; c.stdin = { on() {}, end() {} }; spawned.push(c); return c; },
  });
  const first = cr.start('r1');
  cr.stop('r1');
  await cr.start('r1'); // the newer launch spawns while the older one is still waiting
  assert.equal(spawned.length, 1);
  release();
  await first;
  assert.equal(spawned.length, 1);
  assert.equal(cr.running('r1'), true);
  cr.stop('r1');
  assert.deepEqual(killed, [4242]);
  assert.equal(cr.running('r1'), false);
});
