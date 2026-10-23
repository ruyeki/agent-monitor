import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { boot, mcpClient, req, until, runIdOf, freePort, sleep, tmp, REPO } from './holdout-helpers.js';

const BIN = path.join(REPO, 'bin', 'agent-monitor.js');

function runCli(args, env = {}) {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const out = { stdout: '', stderr: '', code: null, exited: false };
  child.stdout.on('data', (c) => { out.stdout += c; });
  child.stderr.on('data', (c) => { out.stderr += c; });
  child.on('exit', (code) => { out.code = code; out.exited = true; });
  out.kill = () => { try { child.kill(); } catch {} };
  return out;
}
const waitExit = (o, ms) => until(() => o.exited, ms, 50);

async function waitingRun(api, call, title) {
  const id = runIdOf((await call('start_run', { title })).text);
  await call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  return id;
}

test('AC11 wait prints exactly one JSON line and exits 0 after respond', async () => {
  const S = await boot(); const M = await mcpClient(S.url);
  let cli;
  try {
    const id = await waitingRun(S.api, M.call, 'Cli wait');
    cli = runCli(['wait', id], { AGENT_MONITOR_URL: S.url });
    await sleep(700);
    assert.equal(cli.exited, false, 'still waiting');
    assert.equal(cli.stdout, '');
    await S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'the plan is X' } });
    assert.ok(await waitExit(cli, 8000), 'exited. stderr=' + cli.stderr);
    assert.equal(cli.code, 0);
    const outLines = cli.stdout.split('\n').filter((l) => l.length);
    assert.equal(outLines.length, 1, cli.stdout);
    const j = JSON.parse(outLines[0]);
    assert.deepEqual(Object.keys(j).sort(), ['action', 'run', 'stage', 'status', 'text']);
    assert.equal(j.run, id);
    assert.match(j.action, /agree spec/i);
    assert.equal(j.text, 'the plan is X');
    assert.equal(j.stage, 'plan');
    assert.equal(j.status, 'active');
  } finally { cli?.kill(); await M.client.close().catch(() => {}); await S.srv.close(); }
});

test('AC11 wait exits 1 with a stderr message for an unknown run', async () => {
  const S = await boot();
  const cli = runCli(['wait', 'no-such-run'], { AGENT_MONITOR_URL: S.url });
  try {
    assert.ok(await waitExit(cli, 8000));
    assert.equal(cli.code, 1);
    assert.ok(cli.stderr.length > 0);
    assert.equal(cli.stdout, '');
  } finally { cli.kill(); await S.srv.close(); }
});

test('AC11 wait retries silently while the server is down, then finishes when it is back and answered', async () => {
  const port = await freePort();
  const home = tmp('am-cli-home-'); const projects = tmp('am-cli-proj-');
  let S = await boot({ port, home, projects });
  let M = await mcpClient(S.url);
  const id = await waitingRun(S.api, M.call, 'Cli retry');
  await M.client.close().catch(() => {});
  await S.srv.close();
  const cli = runCli(['wait', id], { AGENT_MONITOR_URL: `http://127.0.0.1:${port}` });
  try {
    await sleep(3500);
    assert.equal(cli.exited, false, 'must keep retrying while the server is down');
    assert.equal(cli.stdout, '');
    assert.equal(cli.stderr, '', 'silent retries');
    S = await boot({ port, home, projects });
    await sleep(500);
    const r = await S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Agree spec', text: 'back again' } });
    assert.equal(r.status, 200, 'run survived the restart');
    assert.ok(await waitExit(cli, 12000), 'exited after restart. stderr=' + cli.stderr);
    assert.equal(cli.code, 0);
    assert.equal(JSON.parse(cli.stdout.trim()).text, 'back again');
  } finally { cli.kill(); await S.srv.close().catch(() => {}); }
});

test('AC11 wait survives a 5xx-free restart cycle and returns immediately if the run is no longer waiting', async () => {
  const S = await boot(); const M = await mcpClient(S.url);
  try {
    const id = runIdOf((await M.call('start_run', { title: 'Cli active' })).text);
    const cli = runCli(['wait', id], { AGENT_MONITOR_URL: S.url });
    assert.ok(await waitExit(cli, 6000), 'active run returns at once');
    assert.equal(cli.code, 0);
    assert.equal(JSON.parse(cli.stdout.trim()).status, 'active');
  } finally { await M.client.close().catch(() => {}); await S.srv.close(); }
});

test('serve: boots without the ExperimentalWarning flag, quiet, answers the API, creates the data dir', async () => {
  const port = await freePort();
  const home = path.join(tmp('am-serve-'), 'data');
  const child = spawn(process.execPath, [BIN, 'serve'], { env: { ...process.env, AGENT_MONITOR_PORT: String(port), AGENT_MONITOR_HOME: home, AGENT_MONITOR_PROJECTS_DIR: tmp('am-serve-proj-') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  try {
    const ok = await until(async () => (await req(port, 'GET', '/api/runs')).status === 200, 10000, 150);
    assert.ok(ok, 'server answered; stderr=' + err);
    assert.ok(!/ExperimentalWarning/.test(err), err);
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(path.join(home, 'agent-monitor.db')));
  } finally { child.kill(); }
});
