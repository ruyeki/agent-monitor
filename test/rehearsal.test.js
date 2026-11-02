// AC10: the whole Claude -> Codex hand-off through a booted server, with a stub standing in for `codex`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { HANDOFF, HANDOFF_PROFILE } from '../src/codex-config.js';
import { mcpClient, req } from './holdout-helpers.js';
import { STUB, tmp, until, makeWorld, calls, readLog } from './codex-helpers.js';

const MCP = 'mcp__agent-monitor__';
const LIMIT = "You've hit your usage limit. Upgrade or try again later.";
const OK = [{ type: 'thread.started', thread_id: 'thr-r' }, { type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 7 } }];

async function boot(t, steps, { killTree, codex = true } = {}) {
  const world = makeWorld();
  const log = path.join(world.base, 'stub.log');
  const release = path.join(world.base, 'release');
  const env = { ...process.env, AM_STUB_LOG: log, AM_STUB_CALLS: calls(steps), AM_STUB_RELEASE: release };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: codex ? { command: process.execPath, args: [STUB], root: world.root, env, killTree } : undefined,
  });
  const m = await mcpClient(srv.url);
  t.after(async () => { try { await m.client.close(); } catch { /* closed */ } await srv.close(); });
  const claude = (body) => req(srv.port, 'POST', '/hook', { body: { session_id: 'claude-1', cwd: world.repo, ...body } });
  const codexHook = (body) => req(srv.port, 'POST', '/hook/codex', { body: { session_id: 'thr-r', ...body } });
  const api = (method, p, body) => req(srv.port, method, p, { body });
  const run = () => srv.store.summary(srv.store.getRun('rehearsal'));
  const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
  const letChildExit = async () => { fs.writeFileSync(release, ''); await until(() => fs.existsSync(`${release}.done`)); await new Promise((r) => setTimeout(r, 250)); };
  return { world, srv, m, letChildExit, claude, codexHook, api, run, log, lines: () => readLog(log), denied };
}

// A run on Claude, linked to session claude-1, standing at `plan`.
async function claudeRunAtPlan(x) {
  await x.m.call('start_run', { title: 'Rehearsal', repo: x.world.repo });
  await x.claude({ hook_event_name: 'PostToolUse', tool_name: `${MCP}start_run`, tool_input: { title: 'Rehearsal' }, tool_response: 'RUN rehearsal · stage frame' });
  await x.m.call('complete_stage', { run: 'rehearsal', stage: 'frame', outcome: 'done' });
  await x.m.call('respond', { run: 'rehearsal', action: 'Agree spec' });
  assert.equal(x.run().stage, 'plan');
}

test('AC10: limit -> launch -> Codex reports stages -> gate answer resumes -> Codex limit parks the run at Decision', async (t) => {
  const x = await boot(t, [{ lines: OK, hold: true }, { lines: [{ type: 'error', message: LIMIT }, { type: 'turn.failed', error: { message: LIMIT } }], exit: 1 }]);
  await claudeRunAtPlan(x);

  // 1. a fake limit event: the hook answers at once, the hand-off follows
  const sf = await x.claude({ hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: 1791655200 } });
  assert.deepEqual(sf.json, {});
  await until(() => x.lines().length === 1 && x.srv.store.getRun('rehearsal').codex_thread_id === 'thr-r');

  // 2. Codex launched with the right arguments, the prompt on stdin
  const [first] = x.lines();
  assert.deepEqual(first.argv, ['exec', '--json', '-p', HANDOFF_PROFILE, '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, '--disable', 'fast_mode', '-C', x.world.repo, '-']);
  assert.doesNotMatch(first.argv.join(' '), /astra|ultra|fast(?!_mode)/i);
  assert.match(first.stdin, /run "rehearsal"/);
  assert.match(first.stdin, /plan \(/);
  const r = x.run();
  assert.equal(r.provider, 'codex');
  assert.equal(r.limitSource, 'stopfailure');
  assert.equal(r.resetsAt, new Date(1791655200 * 1000).toISOString());

  // Claude's session is told to stop
  const blocked = await x.claude({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' } });
  assert.ok(x.denied(blocked));
  assert.match(blocked.json.hookSpecificOutput.permissionDecisionReason, /handed over to Codex/);

  // 3. complete_stage from the Codex side moves the run (MCP call plus /hook/codex events keyed by the thread id)
  const stage = async (name, outcome) => {
    const input = { run: 'rehearsal', stage: name, outcome };
    assert.deepEqual((await x.codexHook({ hook_event_name: 'PreToolUse', tool_name: `${MCP}complete_stage`, tool_input: input, tool_use_id: `u-${name}` })).json, {});
    const res = await x.m.call('complete_stage', input);
    assert.equal(res.isError, false, res.text);
    await x.codexHook({ hook_event_name: 'PostToolUse', tool_name: `${MCP}complete_stage`, tool_input: input, tool_response: res.text, tool_use_id: `u-${name}` });
  };
  await stage('plan', 'done');
  assert.deepEqual(x.run().active.map((a) => a.id).sort(), ['implement', 'prep']);
  await stage('implement', 'done');
  await stage('prep', 'done');
  await stage('verify', 'pass');
  assert.equal(x.run().stage, 'review');
  await stage('review', 'pass');
  await stage('whitehat', 'pass');
  await stage('commit', 'done');
  await stage('report', 'done');
  assert.equal(x.run().status, 'waiting');
  assert.equal(x.run().stage, 'gate2');

  const detail = (await x.api('GET', '/api/runs/rehearsal')).json;
  const main = detail.agents.find((a) => a.id === 'codex:thr-r');
  assert.equal(main.provider, 'codex');
  assert.ok(detail.visits.filter((v) => ['implement', 'verify', 'gate2'].includes(v.node)).every((v) => v.provider === 'codex'));
  assert.ok(detail.visits.some((v) => v.node === 'plan' && v.provider === 'codex'));
  assert.ok(detail.visits.some((v) => v.node === 'frame' && v.provider === 'claude'));
  assert.equal(detail.tokens.codex.total, 107);
  assert.equal(detail.tokens.codex.cost, 0);
  assert.equal(detail.tokens.total.total, 0, 'Claude totals are untouched by Codex tokens');
  assert.equal(x.lines().length, 1, 'no extra Codex process for stage reports');

  // the first Codex child now exits 0 with the run waiting at the gate: no escalation to Decision
  await x.letChildExit();
  assert.equal(x.run().status, 'waiting');
  assert.equal(x.run().stage, 'gate2');

  // Codex may not answer a gate, and Ryan's answer through the UI route resumes the thread
  assert.ok(x.denied(await x.codexHook({ hook_event_name: 'PreToolUse', tool_name: `${MCP}respond`, tool_input: { run: 'rehearsal', action: 'Accept' } })));
  const ans = await x.api('POST', '/api/runs/rehearsal/respond', { action: 'Request changes', text: 'redo the tests' });
  assert.equal(ans.status, 200);

  // 4. the answer called `exec resume`; 5. the stub's limit message parks the run at Decision
  await until(() => x.run().stage === 'decision');
  const lines = x.lines();
  assert.equal(lines.length, 2);
  assert.deepEqual(lines[1].argv, ['exec', '-p', HANDOFF_PROFILE, 'resume', '--json', '-m', HANDOFF.model, '-c', `model_reasoning_effort="${HANDOFF.effort}"`, '--disable', 'fast_mode', 'thr-r', '-']);
  assert.equal(lines[1].stdin, 'Ryan answered at gate2: Request changes — redo the tests. Call get_run with run "rehearsal" and continue from the current node.');
  assert.doesNotMatch(lines.map((l) => l.argv.join(' ')).join(' '), /astra|ultra|tier/i);
  const parked = x.run();
  assert.equal(parked.status, 'waiting');
  assert.equal(parked.ask, `Codex usage limit hit: ${LIMIT}`);
  assert.equal(parked.provider, 'codex');
  await new Promise((r2) => setTimeout(r2, 200));
  assert.equal(x.lines().length, 2, 'no retry');
  assert.ok((await x.api('GET', '/api/stats/usage')).json.codex.today.total >= 107);
});

test('an answer through the MCP respond tool resumes Codex too', async (t) => {
  const x = await boot(t, [{ lines: OK }, { lines: [] }]);
  await claudeRunAtPlan(x);
  await x.claude({ hook_event_name: 'StopFailure', error: 'rate_limit' });
  await until(() => x.lines().length === 1 && x.srv.store.getRun('rehearsal').codex_thread_id === 'thr-r');
  await until(() => x.srv.store.summary(x.srv.store.getRun('rehearsal')).status === 'active');
  x.srv.store.escalate('rehearsal', 'needs Ryan');
  const res = await x.m.call('respond', { run: 'rehearsal', action: 'Resume' });
  assert.equal(res.isError, false, res.text);
  await until(() => x.lines().length === 2);
  assert.equal(x.lines()[1].argv[3], 'resume');
  assert.match(x.lines()[1].stdin, /Ryan answered at decision: Resume\./);
});

test('Stop on a Codex run kills the child tree, and the Codex hooks then deny', async (t) => {
  const killed = [];
  const x = await boot(t, [{ lines: OK, sleep: 30000, exit: 1 }], { killTree: (pid) => { killed.push(pid); process.kill(pid); } });
  await claudeRunAtPlan(x);
  await x.claude({ hook_event_name: 'StopFailure', error: 'rate_limit' });
  await until(() => x.srv.store.getRun('rehearsal').codex_thread_id === 'thr-r');
  await x.codexHook({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'ls' } });
  const stop = await x.api('POST', '/api/runs/rehearsal/stop');
  assert.equal(stop.status, 200);
  assert.equal(killed.length, 1);
  assert.ok(x.denied(await x.codexHook({ hook_event_name: 'PreToolUse', tool_name: 'shell', tool_input: { command: 'ls' } })));
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(x.run().status, 'stopped');
  assert.equal(x.run().stage, 'stopped');
});

test('without the codex option a limit hit is recorded but nothing is spawned', async (t) => {
  const x = await boot(t, [{ lines: OK }], { codex: false });
  await claudeRunAtPlan(x);
  await x.claude({ hook_event_name: 'StopFailure', error: 'rate_limit' });
  await until(() => x.srv.store.getRun('rehearsal').limit_at);
  const r = x.run();
  assert.equal(r.provider, 'claude');
  assert.ok(r.limitAt);
  assert.equal(x.lines().length, 0);
  assert.match(r.note, /Codex hand-off is off/);
  assert.ok(!x.denied(await x.claude({ hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: 'a' } })));
});
