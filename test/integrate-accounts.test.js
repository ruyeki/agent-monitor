import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// statusLine usage recorder in settings.json: install, re-install, uninstall, dry-run. Temp homes only.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'integrate.js');
const ORIGINAL = 'node "$HOME/.claude/statusline.js"';
const OURS = `"${process.execPath.replace(/\\/g, '/')}" "${path.join(ROOT, 'bin', 'agent-monitor.js').replace(/\\/g, '/')}" statusline-record`;

let tmp, home, args;

const run = (...a) => spawnSync(process.execPath, [SCRIPT, ...a, ...args], { encoding: 'utf8' });
const settingsFile = () => path.join(home, 'settings.json');
const read = () => fs.readFileSync(settingsFile(), 'utf8');
const write = (obj) => fs.writeFileSync(settingsFile(), JSON.stringify(obj, null, 2) + '\n');
const statusLine = () => JSON.parse(read()).statusLine;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-integrate-acc-'));
  home = path.join(tmp, 'claude-home');
  fs.mkdirSync(home, { recursive: true });
  // a harmless claude: node running an empty script, so `mcp get/add/remove` never touch anything real
  const noop = path.join(tmp, 'noop.js');
  fs.writeFileSync(noop, 'process.exit(0);\n');
  const claude = process.platform === 'win32' ? path.join(tmp, 'noop.cmd') : path.join(tmp, 'noop.sh');
  if (process.platform === 'win32') fs.writeFileSync(claude, `@node "${noop}" %*\r\n`);
  else fs.writeFileSync(claude, `#!/bin/sh\nexec node "${noop}" "$@"\n`, { mode: 0o755 });
  args = ['--home', home, '--codex-home', path.join(tmp, 'codex-home'), '--agents-home', path.join(tmp, 'agents-home'), '--startup', path.join(tmp, 'startup'), '--claude', claude];
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('install prefixes the recorder onto an existing statusLine and keeps its other keys', () => {
  write({ statusLine: { type: 'command', command: ORIGINAL, padding: 2 } });
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(statusLine(), { type: 'command', command: `${OURS} | ${ORIGINAL}`, padding: 2 });
});

test('install without a statusLine adds a quiet recorder', () => {
  write({ model: 'opus' });
  assert.equal(run('install').status, 0);
  assert.deepEqual(statusLine(), { type: 'command', command: `${OURS} --quiet` });
});

test('install with no settings.json at all adds the quiet recorder', () => {
  assert.equal(run('install').status, 0);
  assert.equal(statusLine().command, `${OURS} --quiet`);
});

test('re-install is idempotent and never double-prefixes', () => {
  write({ statusLine: { type: 'command', command: ORIGINAL } });
  run('install');
  const once = read();
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(), once);
  assert.equal(statusLine().command.split('statusline-record').length, 2);
});

test('an older prefix (other node and repo path) is replaced by the current one', () => {
  const old = `"C:/old/node.exe" "C:/old/repo/bin/agent-monitor.js" statusline-record | ${ORIGINAL}`;
  write({ statusLine: { type: 'command', command: old } });
  assert.equal(run('install').status, 0);
  assert.equal(statusLine().command, `${OURS} | ${ORIGINAL}`);
});

test('uninstall restores the original statusLine byte-for-byte', () => {
  write({ model: 'opus', statusLine: { type: 'command', command: ORIGINAL, padding: 2 }, theme: 'dark' });
  const before = read();
  assert.equal(run('install').status, 0);
  assert.notEqual(read(), before);
  const r = run('uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(), before);
  assert.equal(statusLine().command, ORIGINAL);
});

test('uninstall removes a statusLine that only held the quiet recorder', () => {
  write({ model: 'opus' });
  run('install');
  assert.ok(statusLine());
  assert.equal(run('uninstall').status, 0);
  assert.equal('statusLine' in JSON.parse(read()), false);
});

test('uninstall leaves a statusLine that is not ours alone', () => {
  write({ statusLine: { type: 'command', command: ORIGINAL } });
  assert.equal(run('uninstall').status, 0);
  assert.equal(statusLine().command, ORIGINAL);
});

test('dry-run writes nothing and mentions the statusLine', () => {
  write({ statusLine: { type: 'command', command: ORIGINAL } });
  const before = read();
  const r = run('install', '--dry-run');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /statusLine/);
  assert.equal(read(), before);
  assert.deepEqual(fs.readdirSync(home), ['settings.json']);
  assert.equal(fs.existsSync(path.join(tmp, 'startup')), false);
  const u = run('uninstall', '--dry-run');
  assert.match(u.stdout, /statusLine/);
  assert.equal(read(), before);
});
