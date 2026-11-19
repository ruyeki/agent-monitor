import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runAccountsCli } from '../src/accounts/cli.js';
import { memoryVault } from '../src/accounts/vault.js';
import { loadRegistry, writeUsage } from '../src/accounts/state.js';
import { world, oauth, win, secs, readLog, STUB, NOW, tmp } from './accounts-helpers.js';
import path from 'node:path';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const LAB = oauth('uuid-lab');

async function cli(w, argv, extra = {}) {
  const out = [];
  const err = [];
  const code = await runAccountsCli(argv, { dataDir: w.dataDir, home: w.home, vault: w.vault, out: (s) => out.push(s), err: (s) => err.push(s), ...extra });
  return { code, out: out.join('\n'), err: err.join('\n') };
}

// A vault that fails the test if anything touches it.
const untouchable = () => {
  const boom = () => { throw new Error('the vault was touched'); };
  return { prefix: 'x/', get: boom, getMany: boom, set: boom, setMany: boom, delete: boom, list: boom };
};

test('cli list: a plain table with marker, %, left, resets, status and refresh date; no vault, no token text', async (t) => {
  const real = Date.now();
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS, lab: LAB, zed: oauth('uuid-zed') }, live: RYAN, vault: memoryVault() });
  const r5 = secs(real + 3600_000);
  writeUsage(w.dataDir, 'ryan', { reading: { five_hour: win(15, r5), seven_day: win(37, secs(real + 3 * 86400_000)), at: 'x' }, limit: null });
  writeUsage(w.dataDir, 'orders', { reading: null, limit: { at: new Date(real).toISOString(), resetsAt: r5 } });
  const reg = loadRegistry(w.dataDir);
  reg.accounts.zed.savedAt = null;
  fs.writeFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), JSON.stringify(reg));

  const r = await cli({ ...w, vault: untouchable() }, ['list']);
  assert.equal(r.code, 0, r.err);
  const lines = r.out.split('\n');
  assert.match(lines[0], /NAME\s+5H\s+7D\s+LEFT\s+5H RESETS\s+7D RESETS\s+STATUS\s+REFRESH BY/);
  const row = (name) => lines.find((l) => l.split(/\s+/).includes(name));
  assert.match(row('ryan'), /^\*\s+ryan\s+15%\s+37%\s+63%\s+\d\d-\d\d \d\d:\d\d\s+\d\d-\d\d \d\d:\d\d\s+active\s+\d{4}-\d\d-\d\d$/);
  assert.match(row('orders'), /^\s+orders\s+-\s+-\s+100%.*limited until \d\d-\d\d \d\d:\d\d/);
  assert.match(row('lab'), /^\s+lab\s+-\s+-\s+100%.*no reading/);
  assert.match(row('zed'), /no saved login/);
  assert.doesNotMatch(r.out, /FAKE|sk-ant|accessToken|refreshToken/);
});

test('cli list: no accounts says how to add one', async (t) => {
  const w = world(t, { live: RYAN });
  const r = await cli(w, ['accounts', 'list']);
  assert.equal(r.code, 0);
  assert.match(r.out, /accounts add <name>/);
});

test('cli add --current, use, remove: exit codes and messages, never a token', async (t) => {
  const w = world(t, { live: RYAN });
  let r = await cli(w, ['add', 'ryan', '--current', '--email', 'ryan@example.com']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Saved account "ryan" \(ryan@example\.com\)/);
  w.vault.entries.set('account/orders', JSON.stringify(ORDERS));
  const reg = loadRegistry(w.dataDir);
  reg.accounts.orders = { accountUuid: 'uuid-orders', email: null, addedAt: 'x', savedAt: 'x', refreshExpiresAt: null };
  fs.writeFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), JSON.stringify(reg));

  r = await cli(w, ['use', 'orders']);
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Switched the Claude login to "orders"/);
  assert.equal(JSON.parse(w.live()).claudeAiOauth.accountUuid, 'uuid-orders');
  r = await cli(w, ['use', 'orders']);
  assert.match(r.out, /already the live login/);

  r = await cli(w, ['use', 'nobody']);
  assert.equal(r.code, 1);
  assert.match(r.err, /no account named "nobody"/);
  r = await cli(w, ['add', 'second', '--current']);
  assert.equal(r.code, 1);
  assert.match(r.err, /already saved as "orders"/);

  r = await cli(w, ['remove', 'ryan']);
  assert.equal(r.code, 0);
  assert.equal(w.vault.entries.has('account/ryan'), false);
  const all = JSON.stringify(r) + fs.readFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), 'utf8');
  assert.doesNotMatch(all, /FAKE/);
});

test('cli: usage errors exit 2', async (t) => {
  const w = world(t, { live: RYAN });
  for (const argv of [[], ['nope'], ['add'], ['add', 'Bad'], ['use'], ['use', 'a', 'b'], ['list', 'x'], ['add', 'a', '--bogus'], ['add', 'a', '--email'], ['use', 'a', '--current'], ['refresh', 'a', 'b']]) {
    const r = await cli(w, argv);
    assert.equal(r.code, 2, JSON.stringify(argv));
    assert.match(r.err, /^Usage: agent-monitor accounts/);
  }
});

test('cli refresh: one account by name, or the due ones; failures exit 1', async (t) => {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const LABSOON = oauth('uuid-lab', { refreshTokenExpiresAt: NOW + 86400_000 });
  const env = { AM_LOGIN_LOG: log, AM_LOGIN_STUB: '{}' };
  const w = world(t, { accounts: { ryan: RYAN, lab: LABSOON }, live: RYAN });
  const old = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => { for (const k of Object.keys(env)) if (!(k in old)) delete process.env[k]; });
  const claude = { command: process.execPath, args: [STUB] };
  let r = await cli(w, ['refresh', 'lab'], { claude });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /Refreshed "lab"/);
  r = await cli(w, ['refresh', 'ryan'], { claude });
  assert.equal(r.code, 1);
  assert.match(r.err, /live login/);
  r = await cli(w, ['refresh'], { claude });
  assert.equal(r.code, 0, r.err);
  assert.match(r.out, /No saved login needs a refresh|Refreshed "lab"/);
  assert.ok(readLog(log).length >= 1);
  r = await cli(w, ['refresh', 'lab'], { claude: null });
  assert.equal(r.code, 1);
  assert.match(r.err, /Claude Code was not found/);
});

// bin: account setup failing must not stop serve, and `accounts` prints one line, no stack.
const BIN = path.join(import.meta.dirname, '..', 'bin', 'agent-monitor.js');
const badEnv = (t) => ({ ...process.env, AGENT_MONITOR_HOME: tmp(t, 'am-bin-data-'), AGENT_MONITOR_CLAUDE_HOME: tmp(t, 'am-bin-home-'), AGENT_MONITOR_VAULT_PREFIX: 'not-a-test-prefix/', AGENT_MONITOR_PROJECTS_DIR: tmp(t, 'am-bin-proj-'), AGENT_MONITOR_CODEX: 'off' });

test('bin accounts: a setup error prints "accounts: <message>" and exits 1, no stack', async (t) => {
  const { spawnSync } = await import('node:child_process');
  const r = spawnSync(process.execPath, [BIN, 'accounts', 'list'], { env: badEnv(t), encoding: 'utf8', windowsHide: true });
  assert.equal(r.status, 1);
  assert.match(r.stderr.trim(), /^accounts: invalid vault prefix$/);
});

test('bin serve: boots with rotation off and one stderr line when account setup throws', async (t) => {
  const { spawn } = await import('node:child_process');
  const net = await import('node:net');
  const port = await new Promise((res) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  let child = null;
  t.after(async () => { if (child && child.exitCode == null) { const done = new Promise((r) => child.once('exit', r)); child.kill(); await done; } }); // before the temp dirs go
  child = spawn(process.execPath, [BIN, 'serve'], { env: { ...badEnv(t), AGENT_MONITOR_PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let err = '';
  child.stderr.on('data', (c) => { err += c; });
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`http://127.0.0.1:${port}/api/runs`)).status === 200; } catch { await new Promise((r) => setTimeout(r, 150)); }
  }
  assert.ok(up, `server answered; stderr=${err}`);
  assert.deepEqual(err.trim().split('\n'), ['Account rotation off: invalid vault prefix']);
});
