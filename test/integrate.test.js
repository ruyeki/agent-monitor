import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'integrate.js');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'settings.json');
const FILES = ['skills/fable-workflow/SKILL.md', 'skills/fable-workflow/tracking.md', 'skills/next/SKILL.md', 'agents/fable-lead.md'];
const EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];
const MCP_ADD = ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agent-monitor', 'http://127.0.0.1:4747/mcp'];

let tmp, home, startup, claude, log, state;

// A fake claude CLI: records its args, and `mcp get` succeeds only after `mcp add`.
function makeFakeClaude() {
  const js = path.join(tmp, 'fake-claude.js');
  fs.writeFileSync(js, `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
const state = ${JSON.stringify(state)};
if (a[1] === 'add') fs.writeFileSync(state, '1');
if (a[1] === 'remove') fs.rmSync(state, { force: true });
if (a[1] === 'get') process.exit(fs.existsSync(state) ? 0 : 1);
`);
  if (process.platform === 'win32') {
    const cmd = path.join(tmp, 'fake-claude.cmd');
    fs.writeFileSync(cmd, `@node "${js}" %*\r\n`);
    return cmd;
  }
  const sh = path.join(tmp, 'fake-claude.sh');
  fs.writeFileSync(sh, `#!/bin/sh\nexec node "${js}" "$@"\n`, { mode: 0o755 });
  return sh;
}

const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--home', home, '--startup', startup, '--claude', claude], { encoding: 'utf8' });
const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const settingsPath = () => path.join(home, 'settings.json');
const readSettings = () => JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
const backups = (dir, prefix) => fs.readdirSync(dir).filter((f) => f.startsWith(prefix));
const vbs = () => path.join(startup, 'Agent Monitor.vbs');
const cmds = (s) => Object.values(s.hooks).flat().flatMap((e) => e.hooks.map((h) => h.command));

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-integrate-'));
  home = path.join(tmp, 'claude-home');
  startup = path.join(tmp, 'startup');
  log = path.join(tmp, 'claude-calls.log');
  state = path.join(tmp, 'mcp-registered');
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(FIXTURE, settingsPath());
  for (const rel of FILES) {
    const f = path.join(home, ...rel.split('/'));
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `original ${rel}\n`);
  }
  claude = makeFakeClaude();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('install swaps Orca hooks for ours and keeps every other key byte-identical', () => {
  const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  const after = readSettings();
  assert.ok(!cmds(after).some((c) => c.includes('.orca/agent-hooks')), 'Orca entries remain');
  assert.deepEqual(Object.keys(after.hooks).sort(), [...EVENTS].sort());
  for (const ev of EVENTS) {
    const ours = after.hooks[ev].filter((e) => e.hooks.some((h) => /127\.0\.0\.1:4747\/hook/.test(h.command)));
    assert.equal(ours.length, 1, ev);
    assert.equal(ours[0].hooks[0].timeout, 3);
    assert.equal(ours[0].hooks[0].type, 'command');
    assert.equal(ours[0].matcher, ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'].includes(ev) ? '*' : undefined);
  }
  // guardrails entry, and every non-hooks key, are untouched
  assert.deepEqual(after.hooks.PreToolUse[0], before.hooks.PreToolUse[0]);
  for (const k of Object.keys(before).filter((k) => k !== 'hooks')) {
    assert.equal(JSON.stringify(after[k]), JSON.stringify(before[k]), k);
  }
  assert.deepEqual(Object.keys(after).filter((k) => k !== 'hooks'), Object.keys(before).filter((k) => k !== 'hooks'));
  const text = fs.readFileSync(settingsPath(), 'utf8');
  assert.ok(text.endsWith('}\n') && !text.includes('\r'));
  assert.equal(text, JSON.stringify(after, null, 2) + '\n');
});

test('install makes one timestamped backup of settings.json', () => {
  run('install');
  const baks = backups(home, 'settings.json.bak-');
  assert.equal(baks.length, 1);
  assert.match(baks[0], /^settings\.json\.bak-\d{8}T\d{6}$/);
  assert.equal(fs.readFileSync(path.join(home, baks[0]), 'utf8'), fs.readFileSync(FIXTURE, 'utf8'));
});

test('second install changes nothing and makes no new backup', () => {
  run('install');
  const snap = () => ({
    s: fs.readFileSync(settingsPath(), 'utf8'),
    v: fs.readFileSync(vbs(), 'utf8'),
    files: FILES.map((rel) => fs.readFileSync(path.join(home, ...rel.split('/')), 'utf8')),
    home: fs.readdirSync(home).sort(),
    skills: fs.readdirSync(path.join(home, 'skills', 'next')).sort(),
  });
  const first = snap();
  const callsAfterFirst = calls().length;
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snap(), first);
  assert.equal(backups(home, 'settings.json.bak-').length, 1);
  assert.equal(calls().slice(callsAfterFirst).filter((c) => c[1] === 'add').length, 0, 'MCP added twice');
});

test('install registers the MCP server once', () => {
  run('install');
  const c = calls();
  assert.deepEqual(c[0], ['mcp', 'get', 'agent-monitor']);
  assert.deepEqual(c[1], MCP_ADD);
  assert.equal(c.length, 2);
});

test('install writes the startup script', () => {
  run('install');
  const v = fs.readFileSync(vbs(), 'utf8');
  assert.match(v, /WScript\.Shell/);
  assert.ok(v.includes(`sh.CurrentDirectory = "${ROOT}"`));
  assert.ok(v.includes(`sh.Run """${process.execPath}"" ""${path.join(ROOT, 'bin', 'agent-monitor.js')}"" serve", 0, False`));
});

test('install copies the workflow files and backs up the originals', () => {
  run('install');
  for (const rel of FILES) {
    const dst = path.join(home, ...rel.split('/'));
    assert.equal(fs.readFileSync(dst, 'utf8'), fs.readFileSync(path.join(ROOT, 'integration', 'claude-files', ...rel.split('/')), 'utf8'));
    const baks = backups(path.dirname(dst), `${path.basename(dst)}.bak-agent-monitor-`);
    assert.equal(baks.length, 1, rel);
    assert.equal(fs.readFileSync(path.join(path.dirname(dst), baks[0]), 'utf8'), `original ${rel}\n`);
  }
});

test('re-install replaces an old Agent Monitor entry on another port', () => {
  run('install');
  const r = spawnSync(process.execPath, [SCRIPT, 'install', '--port', '4800', '--home', home, '--startup', startup, '--claude', claude], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const all = cmds(readSettings());
  assert.equal(all.filter((c) => c.includes('127.0.0.1:4747/hook')).length, 0);
  assert.equal(all.filter((c) => c.includes('127.0.0.1:4800/hook')).length, EVENTS.length);
});

test('uninstall reverses the install', () => {
  run('install');
  // a later backup (an earlier Agent Monitor copy) must not win over Ryan's original
  for (const rel of FILES) fs.writeFileSync(`${path.join(home, ...rel.split('/'))}.bak-agent-monitor-99991231T235959`, 'previous agent monitor copy\n');
  const r = run('uninstall');
  assert.equal(r.status, 0, r.stderr);
  const s = readSettings();
  assert.ok(!cmds(s).some((c) => /127\.0\.0\.1:\d+\/hook/.test(c)));
  const before = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
  assert.deepEqual(s.hooks.PreToolUse, [before.hooks.PreToolUse[0]]);
  for (const k of Object.keys(before).filter((k) => k !== 'hooks')) assert.deepEqual(s[k], before[k], k);
  assert.deepEqual(calls().at(-1), ['mcp', 'remove', '--scope', 'user', 'agent-monitor']);
  assert.ok(!fs.existsSync(vbs()));
  for (const rel of FILES) assert.equal(fs.readFileSync(path.join(home, ...rel.split('/')), 'utf8'), `original ${rel}\n`);
});

test('--dry-run prints a plan and writes and runs nothing', () => {
  const settingsBefore = fs.readFileSync(settingsPath(), 'utf8');
  const homeBefore = fs.readdirSync(home).sort();
  for (const args of [['--dry-run'], ['install', '--dry-run'], ['--dry-run', 'uninstall']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /DRY RUN/);
    assert.match(r.stdout, /settings\.json/);
    assert.match(r.stdout, /MCP/);
    assert.match(r.stdout, /Agent Monitor\.vbs/);
  }
  assert.equal(fs.readFileSync(settingsPath(), 'utf8'), settingsBefore);
  assert.deepEqual(fs.readdirSync(home).sort(), homeBefore);
  assert.ok(!fs.existsSync(startup));
  assert.equal(calls().length, 0);
});

test('bad arguments fail with a message', () => {
  const r = run('--bogus');
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Unknown argument/);
});
