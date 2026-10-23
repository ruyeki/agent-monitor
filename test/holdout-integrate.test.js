import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO, tmp, freePort } from './holdout-helpers.js';

const SCRIPT = path.join(REPO, 'scripts', 'integrate.js');
const realSettings = path.join(os.homedir(), '.claude', 'settings.json');
const realStat = () => { try { const s = fs.statSync(realSettings); return `${s.mtimeMs}:${s.size}`; } catch { return 'none'; } };

const GUARD = { matcher: 'Bash|PowerShell|mcp__github__.*', hooks: [{ type: 'command', command: 'node "C:/Users/x/.claude/hooks/guardrails.js"', timeout: 10 }] };
const orca = (ev) => ({ matcher: '*', hooks: [{ type: 'command', command: `"C:/Users/x/.orca/agent-hooks/win-hook.cmd" ${ev}`, timeout: 5 }] });
const ORCA_EVENTS = ['SessionStart', 'UserPromptSubmit', 'Stop', 'StopFailure', 'SubagentStart', 'SubagentStop', 'TeammateIdle', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PostCompact', 'SessionEnd'];
const OTHER = {
  statusLine: { type: 'command', command: 'node "C:/Users/x/.claude/statusline.js"', padding: 0 },
  enabledPlugins: { 'a@b': true, 'c@d': false },
  permissions: { allow: ['Bash(git status)', 'Read(*)'], deny: ['Bash(rm -rf *)'], defaultMode: 'bypassPermissions' },
  env: { FOO: 'bar' },
  model: 'opus',
};
const OLD_AM = { matcher: '*', hooks: [{ type: 'command', command: "curl -s -m 2 --data-binary @- http://127.0.0.1:4747/hook", timeout: 5 }] };

function settingsObject({ withOldAm = false } = {}) {
  const hooks = { PreToolUse: [GUARD, orca('PreToolUse')] };
  for (const e of ORCA_EVENTS) hooks[e] = [...(hooks[e] || []), orca(e)];
  if (withOldAm) hooks.PostToolUse.push(structuredClone(OLD_AM));
  return { ...structuredClone(OTHER), hooks };
}

function fixture(opts = {}) {
  const root = tmp('am-int-');
  const home = path.join(root, 'claude-home'); const startup = path.join(root, 'startup'); const bin = path.join(root, 'bin');
  fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(startup); fs.mkdirSync(bin);
  const settingsText = JSON.stringify(settingsObject(opts), null, 2) + '\n';
  fs.writeFileSync(path.join(home, 'settings.json'), settingsText);
  // pre-existing skill file to prove backup + restore
  const oldSkill = '# OLD next skill\n';
  fs.mkdirSync(path.join(home, 'skills', 'next'), { recursive: true });
  fs.writeFileSync(path.join(home, 'skills', 'next', 'SKILL.md'), oldSkill);
  // fake claude CLI
  const log = path.join(root, 'claude.log'); const state = path.join(root, 'claude.state');
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), `
const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},a.join(' ')+'\\n');
const st=${JSON.stringify(state)};
if(a[0]==='mcp'&&a[1]==='get'){process.exit(fs.existsSync(st)?0:1);}
if(a[0]==='mcp'&&a[1]==='add'){fs.writeFileSync(st,'1');process.exit(0);}
if(a[0]==='mcp'&&a[1]==='remove'){try{fs.unlinkSync(st)}catch{};process.exit(0);}
process.exit(0);
`);
  const cmd = path.join(bin, 'fake-claude.cmd');
  fs.writeFileSync(cmd, `@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n`);
  return { root, home, startup, cmd, log, state, settingsText, oldSkill, settingsPath: path.join(home, 'settings.json') };
}

function run(f, args, extra = []) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args, '--home', f.home, '--startup', f.startup, '--claude', f.cmd, ...extra], { encoding: 'utf8', timeout: 60000, windowsHide: true, env: { ...process.env, APPDATA: path.join(f.root, 'appdata') } });
  return r;
}
const snapshot = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir); return out;
};
const readSettings = (f) => JSON.parse(fs.readFileSync(f.settingsPath, 'utf8'));
const commandsOf = (entries) => (entries || []).flatMap((e) => (e.hooks || []).map((h) => h.command));
const isAm = (c) => /127\.0\.0\.1:\d+\/hook/.test(c || '');
const amEntries = (s, ev) => (s.hooks[ev] || []).filter((e) => (e.hooks || []).some((h) => isAm(h.command)));
const logLines = (f) => (fs.existsSync(f.log) ? fs.readFileSync(f.log, 'utf8').split('\n').filter(Boolean) : []);
const AM_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];
const claudeFiles = ['skills/fable-workflow/SKILL.md', 'skills/fable-workflow/tracking.md', 'skills/next/SKILL.md', 'agents/fable-lead.md'];

test('AC14 dry-run (alone, and with install) writes nothing and prints a plan', () => {
  for (const args of [['--dry-run'], ['install', '--dry-run']]) {
    const f = fixture();
    const before = snapshot(f.root);
    const r = run(f, args);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stdout.trim().length > 0, 'plan printed');
    assert.deepEqual(snapshot(f.root), before, 'no file changed or created for ' + args.join(' '));
    assert.deepEqual(fs.readdirSync(f.startup), []);
    assert.deepEqual(logLines(f).filter((l) => /mcp (add|remove)/.test(l)), [], 'no mcp changes on dry-run');
  }
});

test('AC14 install: hooks swapped, everything else byte-identical when re-serialised', () => {
  const f = fixture();
  const real0 = realStat();
  const r = run(f, ['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const text = fs.readFileSync(f.settingsPath, 'utf8');
  assert.ok(text.endsWith('\n') && !text.endsWith('\n\n'));
  assert.ok(!text.includes('\r'), 'LF endings');
  const s = JSON.parse(text);
  assert.equal(text, JSON.stringify(s, null, 2) + '\n', 'canonical 2-space serialisation');
  for (const k of Object.keys(OTHER)) assert.equal(JSON.stringify(s[k]), JSON.stringify(OTHER[k]), k + ' untouched');
  assert.deepEqual(s.hooks.PreToolUse.find((e) => e.matcher === GUARD.matcher), GUARD, 'guardrails entry identical');
  assert.ok(!text.includes('.orca/agent-hooks'), 'orca entries removed');
  for (const ev of ['SessionStart', 'UserPromptSubmit', 'StopFailure', 'TeammateIdle', 'PostCompact']) assert.ok(!(ev in s.hooks), ev + ' key removed when left empty');
  for (const ev of AM_EVENTS) {
    const es = amEntries(s, ev);
    assert.equal(es.length, 1, ev + ' has exactly one Agent Monitor entry');
    assert.equal(es[0].matcher ?? '*', '*');
    const h = es[0].hooks[0];
    assert.equal(h.type, 'command');
    assert.equal(h.timeout, 3);
    assert.ok(h.command.includes('curl'));
    assert.ok(h.command.includes('http://127.0.0.1:4747/hook'));
    assert.ok(h.command.includes('--connect-timeout 0.1') && h.command.includes('|| true'));
  }
  assert.equal(realStat(), real0, 'real ~/.claude/settings.json untouched');
});

test('AC14 install makes one timestamped backup with the original bytes', () => {
  const f = fixture();
  assert.equal(run(f, ['install']).status, 0);
  const baks = fs.readdirSync(f.home).filter((n) => /^settings\.json\.bak-\d{8}T\d{6}$/.test(n));
  assert.equal(baks.length, 1, fs.readdirSync(f.home).join(','));
  assert.equal(fs.readFileSync(path.join(f.home, baks[0]), 'utf8'), f.settingsText);
});

test('AC14 old Agent Monitor entries are replaced, never duplicated; --port is honoured', () => {
  const f = fixture({ withOldAm: true });
  assert.equal(run(f, ['install'], ['--port', '5599']).status, 0);
  const s = readSettings(f);
  assert.equal(amEntries(s, 'PostToolUse').length, 1);
  assert.ok(commandsOf(s.hooks.PostToolUse).every((c) => !c.includes('4747')));
  assert.ok(commandsOf(s.hooks.PostToolUse).some((c) => c.includes('127.0.0.1:5599/hook')));
  const mcp = logLines(f).find((l) => /mcp add/.test(l));
  assert.ok(mcp && mcp.includes('--scope user') && mcp.includes('--transport http') && mcp.includes('agent-monitor') && mcp.includes('http://127.0.0.1:5599/mcp'), mcp);
});

test('AC14 install writes the autostart script and the workflow files (with backups)', () => {
  const f = fixture();
  assert.equal(run(f, ['install']).status, 0);
  const vbs = path.join(f.startup, 'Agent Monitor.vbs');
  assert.ok(fs.existsSync(vbs));
  const v = fs.readFileSync(vbs, 'utf8');
  assert.ok(/agent-monitor\.js/.test(v) && /serve/.test(v));
  assert.ok(/,\s*0\b/.test(v), 'hidden window style 0');
  assert.ok(v.replace(/\\/g, '/').toLowerCase().includes(REPO.toLowerCase().replace(/\\/g, '/')), 'points at this repo');
  for (const rel of claudeFiles) {
    const src = path.join(REPO, 'integration', 'claude-files', rel);
    assert.ok(fs.existsSync(src), 'source exists ' + rel);
    assert.equal(fs.readFileSync(path.join(f.home, rel), 'utf8'), fs.readFileSync(src, 'utf8'), rel + ' copied');
  }
  const baks = fs.readdirSync(path.join(f.home, 'skills', 'next')).filter((n) => /^SKILL\.md\.bak-agent-monitor-/.test(n));
  assert.equal(baks.length, 1);
  assert.equal(fs.readFileSync(path.join(f.home, 'skills', 'next', baks[0]), 'utf8'), f.oldSkill);
  assert.equal(logLines(f).filter((l) => /mcp add/.test(l)).length, 1);
});

test('AC14 second install is a no-op: settings bytes, backups, files and mcp calls unchanged', () => {
  const f = fixture();
  assert.equal(run(f, ['install']).status, 0);
  const snap = snapshot(f.root);
  const adds = logLines(f).filter((l) => /mcp add/.test(l)).length;
  const r = run(f, ['install']);
  assert.equal(r.status, 0, r.stderr);
  const after = snapshot(f.root);
  const strip = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !k.endsWith('claude.log')));
  assert.deepEqual(strip(after), strip(snap), 'nothing changed or was added');
  assert.equal(logLines(f).filter((l) => /mcp add/.test(l)).length, adds, 'mcp add not repeated once registered');
});

test('AC14 uninstall removes our hooks, mcp, vbs and restores the workflow files; keeps the rest', () => {
  const f = fixture();
  assert.equal(run(f, ['install']).status, 0);
  const r = run(f, ['uninstall']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const text = fs.readFileSync(f.settingsPath, 'utf8');
  const s = JSON.parse(text);
  assert.ok(!/127\.0\.0\.1:\d+\/hook/.test(text), 'our hooks removed');
  assert.deepEqual(s.hooks.PreToolUse.find((e) => e.matcher === GUARD.matcher), GUARD);
  for (const k of Object.keys(OTHER)) assert.equal(JSON.stringify(s[k]), JSON.stringify(OTHER[k]), k);
  for (const ev of Object.keys(s.hooks)) assert.ok(s.hooks[ev].length > 0, ev + ' not left as an empty key');
  assert.ok(!fs.existsSync(path.join(f.startup, 'Agent Monitor.vbs')));
  assert.ok(logLines(f).some((l) => /mcp remove/.test(l) && l.includes('agent-monitor') && l.includes('--scope user')));
  assert.equal(fs.readFileSync(path.join(f.home, 'skills', 'next', 'SKILL.md'), 'utf8'), f.oldSkill, 'old skill restored');
});

test('AC14 uninstall on a never-installed home does not crash or damage settings', () => {
  const f = fixture();
  const r = run(f, ['uninstall']);
  assert.equal(r.status, 0, r.stderr);
  const s = readSettings(f);
  for (const k of Object.keys(OTHER)) assert.equal(JSON.stringify(s[k]), JSON.stringify(OTHER[k]), k);
  assert.deepEqual(s.hooks.PreToolUse.find((e) => e.matcher === GUARD.matcher), GUARD);
});

// ---- AC16
test('AC16 the installed hook command exits 0 with no output in under 1 s when nothing listens', async () => {
  const f = fixture();
  const port = await freePort();
  assert.equal(run(f, ['install'], ['--port', String(port)]).status, 0);
  const s = readSettings(f);
  const cmd = commandsOf(s.hooks.PreToolUse).find((c) => isAm(c));
  assert.ok(cmd, 'hook command present');
  const bashCandidates = ['C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe', 'bash'];
  const bash = bashCandidates.find((b) => b === 'bash' || fs.existsSync(b));
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    const r = spawnSync(bash, ['-c', cmd], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 's' }), encoding: 'utf8', timeout: 5000, windowsHide: true });
    const dt = Date.now() - t0;
    assert.equal(r.status, 0, 'exit code; stderr=' + r.stderr);
    assert.equal(r.stdout, '', 'no stdout');
    assert.equal(r.stderr, '', 'no stderr');
    assert.ok(dt < 1000, `took ${dt} ms`);
  }
});
