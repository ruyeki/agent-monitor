// Holdouts for AC1-AC7 and AC10: detection, hand-off to a stub Codex, ownership, gates, usage, failures and stop.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  load, req, mcpClient, runIdOf, bootCodex, tmp, sleep, until, makeRepo, started, completed, denied, reason, alive, LIMIT_MSG,
} from './holdout-codex-helpers.js';

const cfg = await load('src/codex-config.js');
const HANDOFF = cfg.HANDOFF;
const eq = (a, b) => (process.platform === 'win32' ? String(a).toLowerCase() === String(b).toLowerCase() : a === b);
const realpath = (p) => fs.realpathSync(p);
const pre = (session, extra = {}) => ({ hook_event_name: 'PreToolUse', session_id: session, tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `t-${Math.random()}`, ...extra });

let app;
before(async () => { app = await bootCodex({ repos: ['repoA', 'a & b (x)'] }); });
after(async () => { await app.close(); });

// A fresh run in repoA with its session linked. Returns { id, s }.
let seq = 0;
async function fresh(extra = {}, { repo = 'repoA', title = 'Run' } = {}) {
  const s = `sess-${++seq}`;
  const id = await app.startRun(`${title} ${seq}`, { repo, ...extra });
  await app.link(s, id);
  return { id, s };
}
// Hooks are handled in order: a sentinel run that does get handed off and shows up in the stub log
// proves every earlier hook (and any launch it would have caused) has been processed.
async function settle() {
  const { id, s } = await fresh({}, { title: 'Sentinel' });
  await app.limit(s);
  assert.ok(await until(() => mine(id).length >= 1), 'sentinel launch seen');
}
const mine = (id) => app.calls().filter((c) => c.stdin.includes(`"${id}"`)); // calls of one run (earlier tests may still be launching)

test('AC1: StopFailure rate_limit marks the run, records time and reset time, and hands off once', async () => {
  const { id, s } = await fresh();
  const before = 0;
  const r = await app.limit(s);
  assert.equal(r.status, 200);
  const d = await until(async () => { const x = (await app.detail(id)).run; return x.provider === 'codex' && x; });
  assert.ok(d, 'run is marked as on Codex');
  assert.equal(d.limitSource, 'stopfailure');
  assert.ok(Date.parse(d.limitAt) > 0, 'limitAt is a time');
  assert.equal(new Date(d.resetsAt).getTime(), 1791655200 * 1000, 'reset time from error_details epoch seconds');
  await app.limit(s); await app.limit(s);
  assert.ok(await until(() => mine(id).length >= 1), 'first launch seen');
  await settle();
  assert.equal(mine(id).length, before + 1, 'at most one Codex launch per run');
});

test('AC1: other errors never trigger a hand-off', async () => {
  for (const error of ['overloaded', 'authentication_failed', 'server_error', 'rate_limit_exceeded', 'Rate_Limit', undefined]) {
    const { id, s } = await fresh({}, {});
    const n = 0;
    await app.limit(s, { error });
    await settle();
    const run = (await app.detail(id)).run;
    assert.ok(!run.limitAt, `error ${error} must not mark the run`);
    assert.notEqual(run.provider, 'codex');
    assert.equal(mine(id).length, n);
  }
});

test('AC1: StopFailure from an unlinked session, or for an ended run, does nothing', async () => {
  const id = await app.startRun('Unlinked', { repo: 'repoA' });
  await app.limit('nobody');
  const { id: id2, s: s2 } = await fresh();
  await app.api('POST', `/api/runs/${id2}/stop`);
  await app.limit(s2);
  await settle();
  assert.ok(!(await app.detail(id)).run.limitAt);
  assert.notEqual((await app.detail(id2)).run.provider, 'codex');
  assert.equal(mine(id).length + mine(id2).length, 0);
});

test('AC1: a StopFailure from a known subagent of a linked run counts for that run', async () => {
  const { id, s } = await fresh();
  await app.post({ hook_event_name: 'SubagentStart', session_id: s, cwd: app.root, agent_id: 'subLim', agent_type: 'general-purpose' });
  await app.limit('some-other-session', { agent_id: 'subLim' });
  const d = await until(async () => { const x = (await app.detail(id)).run; return x.provider === 'codex' && x; });
  assert.ok(d, 'run handed over via the agent link');
});

test('AC2 + AC10: Codex is launched with exact arguments, the prompt on stdin, cwd = the run repo, thread id saved', async () => {
  const note = 'Spec C:\\Users\\ruyek\\.claude\\fable-runs\\zzprobe\\spec.md and C:\\Users\\ruyek\\.claude\\fable-runs\\zzprobe\\facts.md';
  const { id, s } = await fresh({ note });
  const n = mine(id).length;
  await app.limit(s);
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls, 'codex launched');
  const c = calls[n];
  const dir = realpath(path.join(app.root, 'repoA'));
  assert.ok(eq(realpath(c.cwd), dir), 'spawned in the run repo');
  assert.equal(c.argv[0], 'exec');
  assert.deepEqual(c.argv.slice(0, 4), ['exec', '--json', '-p', cfg.HANDOFF_PROFILE]);
  const at = (flag) => c.argv[c.argv.indexOf(flag) + 1];
  assert.equal(at('-m'), HANDOFF.model);
  assert.equal(at('-c'), `model_reasoning_effort="${HANDOFF.effort}"`);
  assert.equal(at('--disable'), 'fast_mode');
  assert.ok(eq(realpath(at('-C')), dir));
  assert.equal(c.argv.at(-1), '-', 'prompt is read from stdin');
  const flat = c.argv.join(' ');
  assert.ok(!/astra/i.test(flat), 'no astra');
  assert.ok(!/ultra/i.test(flat), 'no ultra tier or effort');
  assert.ok(!/service_tier|fast(?!_mode)/i.test(flat), 'no fast tier');
  assert.ok(!flat.includes(id), 'run id is in the prompt, never in argv');
  assert.ok(c.stdin.includes(id), 'prompt names the run');
  assert.ok(c.stdin.includes('frame'), 'prompt names the active node');
  assert.ok(c.stdin.includes('get_run'), 'prompt tells Codex to call get_run');
  assert.ok(c.stdin.includes('zzprobe') && /spec\.md/.test(c.stdin) && /facts\.md/.test(c.stdin), 'spec and fact-sheet paths from the note');
  assert.ok(/##|No commits yet|README/.test(c.stdin), 'git status summary');
  const d = await until(async () => { const x = (await app.detail(id)).run; return x.codexThreadId && x; });
  assert.equal(d.codexThreadId, 'T1');
});

test('AC2: the working directory comes from the run hook payloads when the run has no repo', async () => {
  const s = `sess-${++seq}`;
  const id = await app.startRun(`No repo ${seq}`);
  await app.link(s, id, { cwd: path.join(app.root, 'repoA') });
  await app.post(pre(s, { cwd: tmp('amx-outside-') })); // the most recent cwd is invalid (outside the root)
  const n = mine(id).length;
  await app.limit(s, { cwd: tmp('amx-outside2-') });
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls, 'fell back to a valid recorded cwd');
  assert.ok(eq(realpath(calls[n].cwd), realpath(path.join(app.root, 'repoA'))));
});

test('AC2: a repo path with spaces and shell characters is one argument and a valid cwd', async () => {
  const { id, s } = await fresh({}, { repo: 'a & b (x)' });
  const n = mine(id).length;
  await app.limit(s);
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls);
  const dir = realpath(path.join(app.root, 'a & b (x)'));
  assert.ok(eq(realpath(calls[n].argv[calls[n].argv.indexOf('-C') + 1]), dir));
  assert.ok(eq(realpath(calls[n].cwd), dir));
});

async function expectNoLaunch(extra, repo, why) {
  const { id, s } = await fresh(extra, { repo });
  const n = mine(id).length;
  await app.limit(s);
  const d = await until(async () => { const x = (await app.detail(id)).run; return x.stage === 'decision' && x; }, 20000);
  assert.ok(d, `${why}: run goes to Decision`);
  assert.equal(d.status, 'waiting');
  await sleep(300);
  assert.equal(mine(id).length, n, `${why}: Codex is not started`);
  const text = await app.call('get_run', { run: id });
  assert.ok(/hand-?off failed|no git work tree/i.test(text), `${why}: note says why`);
}

test('AC2: a repo outside the root, a traversal, a junction escape and a non-git dir are all refused', async () => {
  const outside = makeRepo(tmp('amx-out-'), 'out');
  await expectNoLaunch({}, outside, 'absolute outside the root');
  await expectNoLaunch({}, 'repoA/../..', 'traversal');
  const link = path.join(app.root, 'escape');
  fs.symlinkSync(outside, link, 'junction');
  await expectNoLaunch({}, 'escape', 'junction to outside the root');
  makeRepo(app.root, 'plain', { git: false });
  await expectNoLaunch({}, 'plain', 'not a git work tree');
  await expectNoLaunch({}, 'does-not-exist', 'missing directory');
});

test('AC3 + AC10: after hand-off the run, visits and agents say Codex; the Codex side moves the run forward', async () => {
  const { id, s } = await fresh();
  const dBefore = await app.detail(id);
  assert.ok(dBefore.visits.every((v) => (v.provider ?? 'claude') === 'claude'));
  assert.equal(dBefore.run.provider, 'claude');
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.provider === 'codex');
  const d = await app.detail(id);
  assert.ok(d.visits.some((v) => v.provider === 'codex'), 'the open visit now says Codex');
  const text = await app.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  assert.match(text, /gate1|solution/i, 'run moved to the first gate');
  const d2 = await app.detail(id);
  const gate = d2.visits.filter((v) => v.node === 'gate1').at(-1);
  assert.equal(gate.provider, 'codex', 'new visits record the tool that ran them');
});

test('AC3: Claude tool calls of a handed-over run are denied (main, subagent, complete_stage, log); get_run is not', async () => {
  const { id, s } = await fresh();
  await app.post({ hook_event_name: 'SubagentStart', session_id: s, cwd: app.root, agent_id: 'subOwn', agent_type: 'general-purpose' });
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.provider === 'codex');
  const main = await app.post(pre(s));
  assert.ok(denied(main), 'main session denied');
  assert.match(reason(main), /handed over to Codex/);
  assert.ok(reason(main).includes(id));
  assert.ok(denied(await app.post(pre(s, { agent_id: 'subOwn' }))), 'subagent denied');
  assert.ok(denied(await app.post(pre('stranger', { tool_name: 'mcp__agent-monitor__complete_stage', tool_input: { run: id, stage: 'frame', outcome: 'done' } }))), 'complete_stage from an unlinked Claude session denied');
  assert.ok(denied(await app.post(pre('stranger', { tool_name: 'mcp__agent-monitor__log', tool_input: { run: id, note: 'x' } }))), 'log from an unlinked Claude session denied');
  assert.ok(!denied(await app.post(pre(s, { tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id } }))), 'get_run still allowed');
  // Ryan's next prompt frees the main session.
  await app.post({ hook_event_name: 'UserPromptSubmit', session_id: s, cwd: app.root, prompt: 'hi' });
  assert.ok(!denied(await app.post(pre(s))), 'main session is free after UserPromptSubmit');
});

test('AC1: handing off needs a Claude run; a run already on Codex is not handed off twice', async () => {
  const { id, s } = await fresh();
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.codexThreadId === 'T1');
  const n = mine(id).length;
  const first = (await app.detail(id)).run.limitAt;
  await app.limit(s, { error_details: { resetsAt: 1791999999 } });
  await sleep(500);
  assert.equal(mine(id).length, n);
  assert.equal((await app.detail(id)).run.limitAt, first);
});

const SLOW = { default: { events: [started('T1')], sleepMs: 1500 } }; // Codex stays alive until the stage is completed
const FAST = { default: { events: [started('T1')] } };
test('AC4 + AC10: a gate answer (REST) resumes the saved thread with the answer', async () => {
  app.setScript(SLOW);
  const { id, s } = await fresh();
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.codexThreadId === 'T1');
  await app.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const n = mine(id).length;
  const r = await app.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'use plan B please' } });
  assert.equal(r.status, 200);
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls, 'exec resume launched');
  const c = calls[n];
  assert.deepEqual(c.argv, ['exec', '-p', cfg.HANDOFF_PROFILE, 'resume', '--json', '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, '--disable', 'fast_mode', 'T1', '-']);
  assert.ok(c.stdin.includes('use plan B please') && c.stdin.includes('Agree spec'));
  assert.ok(c.stdin.includes(id));
});

test('AC4: the MCP respond tool resumes too, and a Stop answer does not', async () => {
  app.setScript(SLOW);
  const { id, s } = await fresh();
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.codexThreadId === 'T1');
  await app.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  const n = mine(id).length;
  const t = await app.call('respond', { run: id, action: 'Agree spec', text: 'via mcp' });
  assert.match(t, /^RUN /);
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls && calls[n].argv.includes('resume'));
  assert.ok(calls[n].stdin.includes('via mcp'));
  // stop answer: no resume
  const b = await fresh();
  await app.limit(b.s);
  await until(async () => (await app.detail(b.id)).run.codexThreadId === 'T1');
  await app.call('complete_stage', { run: b.id, stage: 'frame', outcome: 'done' });
  const m = mine(b.id).length;
  await app.api('POST', `/api/runs/${b.id}/respond`, { body: { action: 'Stop run' } });
  await sleep(600);
  assert.equal(mine(b.id).length, m, 'a stopped run is not resumed');
  app.setScript(FAST);
});

test('AC1 + AC4: a run waiting on Ryan at the limit is only handed over; Codex starts when Ryan answers', async () => {
  const { id, s } = await fresh();
  await app.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' }); // waits at gate1
  const n = mine(id).length;
  await app.limit(s);
  await until(async () => (await app.detail(id)).run.provider === 'codex');
  await sleep(500);
  assert.equal(mine(id).length, n, 'nothing launched while the run waits');
  await app.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'ok go' } });
  const calls = await until(() => mine(id).length > n && mine(id));
  assert.ok(calls, 'launched on the answer');
  assert.equal(calls[n].argv[0], 'exec');
  assert.ok(calls[n].stdin.includes('ok go'), 'fresh launch carries the answer line');
});

test('AC5: turn.completed usage is stored as Codex tokens and kept apart from Claude tokens', async () => {
  const a = await bootCodex({ repos: ['repoA'], script: { default: { events: [started('TU'), completed(), completed({ input_tokens: 100, cached_input_tokens: 0, output_tokens: 5, reasoning_output_tokens: 0 })] } } });
  try {
    const id = await a.startRun('Usage', { repo: 'repoA' });
    await a.link('su', id);
    const claudeBefore = (await a.detail(id)).tokens.total.total;
    const statsBefore = (await a.api('GET', '/api/stats/usage')).json;
    await a.limit('su');
    const d = await until(async () => { const x = await a.detail(id); return x.tokens?.codex?.total >= 1155 && x; });
    assert.ok(d, 'Codex tokens appear on the run');
    const t = d.tokens.codex;
    assert.equal(t.input, 600 + 100);
    assert.equal(t.cacheRead, 400);
    assert.equal(t.output, 55);
    assert.equal(t.total, 1155);
    assert.ok(!t.cost, 'no dollar estimate for Codex without a price row');
    assert.equal(d.tokens.total.total, claudeBefore, 'Claude totals untouched');
    const st = (await a.api('GET', '/api/stats/usage')).json;
    assert.equal(st.codex.today.total, 1155);
    assert.equal(st.periods.today.total, statsBefore.periods.today.total, 'Claude period totals untouched');
    assert.ok(st.daily.every((r) => (r.provider ?? 'claude') === 'claude' || r.provider === 'codex'));
    assert.ok(st.daily.some((r) => r.provider === 'codex'));
  } finally { await a.close(); }
});

async function failScript(call1, extra = {}) {
  const a = await bootCodex({ repos: ['repoA'], script: { calls: [call1], default: { events: [started('TF')] } }, ...extra });
  const id = await a.startRun('Fail', { repo: 'repoA' });
  await a.link('sf', id);
  await a.limit('sf');
  return { a, id };
}
const parked = (a, id) => until(async () => { const x = (await a.detail(id)).run; return x.stage === 'decision' && x.status === 'waiting' && x; }, 20000);

test('AC6 + AC10: a Codex usage-limit message parks the run at Decision and is never retried', async () => {
  for (const ev of [{ type: 'turn.failed', error: { message: LIMIT_MSG } }, { type: 'error', message: LIMIT_MSG }]) {
    const { a, id } = await failScript({ events: [started('TF'), ev], exit: 1 });
    try {
      assert.ok(await parked(a, id), `parked on ${ev.type}`);
      const text = await a.call('get_run', { run: id });
      assert.match(text, /Codex usage limit hit/);
      await sleep(900);
      assert.equal(a.calls().length, 1, 'no retry');
      assert.equal((await a.detail(id)).run.stage, 'decision');
      // Ryan's Resume on a Codex run goes back to Codex via resume
      await a.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Resume' } });
      const c = await until(() => a.calls().length > 1 && a.calls());
      assert.ok(c && c[1].argv.includes('resume') && c[1].argv.includes('TF'));
    } finally { await a.close(); }
  }
});

test('AC6: other Codex failures go to Decision with the message; a retryable 429 is not a usage limit', async () => {
  for (const message of ['boom happened', 'rate_limit_exceeded: slow down (429)']) {
    const { a, id } = await failScript({ events: [started('TF'), 'not json noise {{', { type: 'turn.failed', error: { message } }], exit: 1 });
    try {
      assert.ok(await parked(a, id));
      const text = await a.call('get_run', { run: id });
      assert.ok(text.includes(message));
      assert.match(text, /Codex failed/);
      assert.ok(!/usage limit hit/i.test(text));
      await sleep(500);
      assert.equal(a.calls().length, 1);
    } finally { await a.close(); }
  }
});

test('AC6: a non-zero exit with no events parks the run; a clean exit does not', async () => {
  const bad = await failScript({ events: [started('TF')], exit: 3 });
  try { assert.ok(await parked(bad.a, bad.id)); assert.match(await bad.a.call('get_run', { run: bad.id }), /exited with code 3/); } finally { await bad.a.close(); }
  const ok = await failScript({ events: [started('TF'), completed()], exit: 0 });
  try {
    await parked(ok.a, ok.id);
    const r = (await ok.a.detail(ok.id)).run;
    // changed rule (attempt 2): a clean exit with the run still active and nothing pending goes to Decision
    assert.equal(r.stage, 'decision');
    assert.match(await ok.a.call('get_run', { run: ok.id }), /ended its turn/i);
  } finally { await ok.a.close(); }
});

test('AC6: a Codex that cannot start parks the run', async () => {
  const { startServer } = await load('src/server.js');
  const root = fs.realpathSync(tmp('amx-root-')); makeRepo(root, 'repoA');
  const srv = await startServer({ port: 0, dataDir: tmp('amx-home-'), projectsDir: tmp('amx-proj-'), webDir: path.join(tmp(), 'nope'), codex: { command: path.join(root, 'no-such-codex.exe'), root } });
  const mcp = await mcpClient(srv.url);
  try {
    const id = runIdOf((await mcp.call('start_run', { title: 'ENOENT', repo: 'repoA' })).text);
    await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'PostToolUse', session_id: 'se', cwd: root, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id }, tool_response: {}, tool_use_id: 'x' } });
    await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'StopFailure', session_id: 'se', cwd: root, error: 'rate_limit' } });
    const d = await until(async () => { const x = (await req(srv.port, 'GET', `/api/runs/${id}`)).json.run; return x.stage === 'decision' && x; }, 20000);
    assert.ok(d, 'run parked at Decision');
    assert.match((await mcp.call('get_run', { run: id })).text, /could not start/i);
  } finally { await mcp.client.close(); await srv.close(); }
});

test('AC7 + AC10: Stop kills the Codex process tree and its hooks deny further tool calls', async () => {
  const a = await bootCodex({ repos: ['repoA'], script: { default: { events: [started('TS')], hang: true, grandchild: true } } });
  try {
    const id = await a.startRun('Stop me', { repo: 'repoA' });
    await a.link('ss', id);
    await a.limit('ss');
    const pidFile = path.join(a.dir, 'pid-1'); const gFile = path.join(a.dir, 'gpid-1');
    assert.ok(await until(() => fs.existsSync(pidFile) && fs.existsSync(gFile)), 'child and grandchild running');
    await until(async () => (await a.detail(id)).run.codexThreadId === 'TS');
    const pid = Number(fs.readFileSync(pidFile, 'utf8')); const gpid = Number(fs.readFileSync(gFile, 'utf8'));
    // before the stop, Codex hooks are allowed
    const base = { hook_event_name: 'PreToolUse', session_id: 'TS', cwd: a.root, tool_name: 'shell', tool_input: { command: 'ls' }, tool_use_id: 'c1' };
    const ok = await a.post(base, '/hook/codex');
    assert.equal(ok.status, 200);
    assert.ok(!denied(ok), 'running Codex is allowed');
    await a.post({ hook_event_name: 'SubagentStart', session_id: 'TS', cwd: a.root, agent_id: 'cagent', agent_type: 'worker' }, '/hook/codex');
    const stop = await a.api('POST', `/api/runs/${id}/stop`);
    assert.equal(stop.status, 200);
    assert.ok(await until(() => !alive(pid) && !alive(gpid), 20000), 'child and grandchild are dead');
    assert.ok(denied(await a.post(base, '/hook/codex')), 'main thread denied');
    assert.ok(denied(await a.post({ ...base, agent_id: 'cagent' }, '/hook/codex')), 'Codex subagent denied');
    assert.ok(!denied(await a.post({ ...base, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: id } }, '/hook/codex')), 'agent-monitor tools stay allowed');
  } finally { await a.close(); }
});

test('AC7: answering Stop run at a gate also kills a running Codex', async () => {
  const a = await bootCodex({ repos: ['repoA'], script: { default: { events: [started('TG')], hang: true } } });
  try {
    const id = await a.startRun('Gate stop', { repo: 'repoA' });
    await a.link('sg', id);
    await a.limit('sg');
    const pidFile = path.join(a.dir, 'pid-1');
    assert.ok(await until(() => fs.existsSync(pidFile)));
    const pid = Number(fs.readFileSync(pidFile, 'utf8'));
    await a.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
    await a.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Stop run' } });
    assert.ok(await until(() => !alive(pid), 20000), 'process killed');
    assert.equal((await a.detail(id)).run.status, 'stopped');
  } finally { await a.close(); }
});

test('AC4: while a Codex child runs, an answer waits for it to exit, then resumes (one child per run)', async () => {
  const a = await bootCodex({ repos: ['repoA'], script: { calls: [{ events: [started('TQ')], sleepMs: 1500 }], default: { events: [started('TQ')] } } });
  try {
    const id = await a.startRun('Queue', { repo: 'repoA' });
    await a.link('sq', id);
    await a.limit('sq');
    await until(async () => (await a.detail(id)).run.codexThreadId === 'TQ');
    await a.call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
    await a.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'queued answer' } });
    await sleep(500);
    assert.equal(a.calls().length, 1, 'second child is not started while the first runs');
    const c = await until(() => a.calls().length >= 2 && a.calls(), 20000);
    assert.ok(c, 'resume starts after the first child exits');
    assert.ok(c[1].argv.includes('resume') && c[1].stdin.includes('queued answer'));
  } finally { await a.close(); }
});

test('Codex hooks: respond and Agent Monitor self-API calls are denied, with or without an agent id; unlinked sessions are ignored', async () => {
  const a = await bootCodex({ repos: ['repoA'] });
  try {
    const id = await a.startRun('Hooks', { repo: 'repoA' });
    await a.link('sh', id);
    await a.limit('sh');
    await until(async () => (await a.detail(id)).run.codexThreadId === 'T1');
    const h = (extra) => a.post({ hook_event_name: 'PreToolUse', session_id: 'T1', cwd: a.root, tool_name: 'shell', tool_input: { command: 'ls' }, tool_use_id: `c${Math.random()}`, ...extra }, '/hook/codex');
    for (const name of ['mcp__agent-monitor__respond', 'agent-monitor.respond', 'agent-monitor:respond', 'agent-monitor/respond']) {
      assert.ok(denied(await h({ tool_name: name, tool_input: { run: id, action: 'Resume' } })), `${name} denied`);
      assert.ok(denied(await h({ tool_name: name, agent_id: 'x1', tool_input: { run: id, action: 'Resume' } })), `${name} denied for a subagent`);
    }
    const cmd = `curl http://127.0.0.1:${a.port}/api/runs/${id}/respond`;
    assert.ok(denied(await h({ tool_input: { command: cmd } })), 'main thread self-API denied');
    assert.ok(denied(await h({ agent_id: 'x2', tool_input: { command: cmd } })), 'subagent self-API denied');
    assert.ok(denied(await h({ tool_input: { command: ['curl', `http://localhost:${a.port}/api/runs`] } })), 'array command denied');
    assert.ok(!denied(await h({ tool_input: { command: 'curl http://127.0.0.1:1/x' } })), 'other ports are fine');
    const d = await a.detail(id);
    const main = d.agents.find((x) => x.id === 'codex:T1');
    assert.ok(main, 'main Codex thread agent exists');
    assert.equal(main.type, 'codex');
    assert.equal(main.provider, 'codex');
    assert.deepEqual((await a.post({ hook_event_name: 'PreToolUse', session_id: 'unknown-thread', tool_name: 'shell', tool_input: { command: 'ls' } }, '/hook/codex')).json, {});
    const junk = await a.post('not an object', '/hook/codex');
    assert.ok(junk.status < 500);
  } finally { await a.close(); }
});

test('hand-off is off when startServer gets no codex option: the run is marked but stays on Claude', async () => {
  const a = await bootCodex({ codex: false, repos: ['repoA'] });
  try {
    const id = await a.startRun('Off', { repo: 'repoA' });
    await a.link('so', id);
    await a.limit('so');
    const d = await until(async () => { const x = (await a.detail(id)).run; return x.limitAt && x; });
    assert.ok(d, 'limit recorded');
    assert.notEqual(d.provider, 'codex');
    assert.ok(!denied(await a.post(pre('so'))), 'Claude side is not denied');
  } finally { await a.close(); }
});

test('shutdown: closing the server with a running Codex child raises no late exception', async () => {
  const errors = [];
  const on = (e) => errors.push(String(e?.message ?? e));
  process.on('uncaughtException', on); process.on('unhandledRejection', on);
  try {
    const a = await bootCodex({ repos: ['repoA'], script: { default: { events: [started('TC'), completed()], sleepMs: 800 } } });
    const id = await a.startRun('Close', { repo: 'repoA' });
    await a.link('sc', id);
    await a.limit('sc');
    await until(() => a.calls().length >= 1);
    await a.close();
    const pid = a.calls()[0].pid;
    await sleep(1500);
    assert.deepEqual(errors, [], 'no exception after close');
    assert.ok(!alive(pid), 'child gone after close');
  } finally { process.off('uncaughtException', on); process.off('unhandledRejection', on); }
});
