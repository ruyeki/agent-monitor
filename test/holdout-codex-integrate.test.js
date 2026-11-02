// Holdouts for AC8: Codex-side install through scripts/integrate.js (temp homes only).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO, tmp, load } from './holdout-codex-helpers.js';

const SCRIPT = path.join(REPO, 'scripts', 'integrate.js');
const SENTINEL = 'AUTH-SENTINEL-DO-NOT-TOUCH';
const CONFIG = [
  'model = "gpt-5.6-sol"',
  'project_doc_max_bytes = 1000',
  'project_doc_fallback_filenames = ["OLD.md"]',
  'approval_policy = "on-request"',
  '',
  "[projects.'C:\\Users\\x']",
  'trust_level = "trusted"',
  '',
  '[windows]',
  'sandbox = "elevated"',
  '',
].join('\n');
const FOREIGN_HOOKS = { hooks: { PreToolUse: [{ matcher: 'shell', hooks: [{ type: 'command', command: 'node "C:/x/guard.js"', timeout: 5 }] }] } };

function fixture({ crlf = false } = {}) {
  const root = tmp('amx-int-');
  const home = path.join(root, 'claude'); const codex = path.join(root, 'codex'); const agents = path.join(root, 'agents'); const startup = path.join(root, 'startup'); const bin = path.join(root, 'bin');
  for (const d of [home, codex, agents, startup, bin, path.join(home, 'agents'), path.join(home, 'skills', 'verifier'), path.join(home, 'skills', 'white-hat'), path.join(home, 'skills', 'other')]) fs.mkdirSync(d, { recursive: true });
  const settings = { permissions: { allow: ['Read(*)'] }, autoContinueAtUsageLimit: true, hooks: {} };
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
  for (const n of ['fable-lead', 'sonnet-engineer', 'opus-engineer', 'haiku-engineer']) {
    fs.writeFileSync(path.join(home, 'agents', `${n}.md`), `---\nname: ${n}\ndescription: Does ${n} things.\nmodel: sonnet\n---\nBody of ${n} with "quotes", \\backslash and a line\nsecond line\n`);
  }
  for (const n of ['verifier', 'white-hat', 'other']) fs.writeFileSync(path.join(home, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: Skill ${n}.\n---\n# ${n}\nSkill body ${n}\n`);
  const cfgText = crlf ? CONFIG.replace(/\n/g, '\r\n') : CONFIG;
  fs.writeFileSync(path.join(codex, 'config.toml'), cfgText);
  fs.writeFileSync(path.join(codex, 'auth.json'), SENTINEL);
  fs.writeFileSync(path.join(codex, 'hooks.json'), JSON.stringify(FOREIGN_HOOKS, null, 2) + '\n');
  const log = path.join(root, 'claude.log'); const st = path.join(root, 'claude.state');
  fs.writeFileSync(path.join(bin, 'fake-claude.js'), `const fs=require('fs');const a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(log)},a.join(' ')+'\\n');const st=${JSON.stringify(st)};if(a[0]==='mcp'&&a[1]==='get')process.exit(fs.existsSync(st)?0:1);if(a[0]==='mcp'&&a[1]==='add'){fs.writeFileSync(st,'1');process.exit(0);}if(a[0]==='mcp'&&a[1]==='remove'){try{fs.unlinkSync(st)}catch{};process.exit(0);}process.exit(0);\n`);
  const cmd = path.join(bin, 'fake-claude.cmd');
  fs.writeFileSync(cmd, '@echo off\r\nnode "%~dp0fake-claude.js" %*\r\n');
  return { root, home, codex, agents, startup, cmd, cfgText, settingsPath: path.join(home, 'settings.json') };
}
const run = (f, args, extra = []) => spawnSync(process.execPath, [SCRIPT, ...args, '--home', f.home, '--codex-home', f.codex, '--agents-home', f.agents, '--startup', f.startup, '--claude', f.cmd, '--port', '4749', ...extra], { encoding: 'utf8', timeout: 90000, windowsHide: true, env: { ...process.env, APPDATA: path.join(f.root, 'appdata') } });
const hashTree = (dir) => {
  const out = {};
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isSymbolicLink()) out[path.relative(dir, p)] = `link:${fs.readlinkSync(p)}`; else if (e.isDirectory()) walk(p); else out[path.relative(dir, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex'); } };
  walk(dir); delete out['claude.log']; return out;
};
const read = (...p) => fs.readFileSync(path.join(...p), 'utf8');
const exists = (...p) => fs.existsSync(path.join(...p));
const baks = (dir, base) => fs.readdirSync(dir).filter((x) => x.startsWith(`${base}.bak-agent-monitor-`));
const tomlStr = (text, key) => { const m = new RegExp(`^${key}\\s*=\\s*(".*")\\s*$`, 'm').exec(text); return m ? JSON.parse(m[1]) : null; };

test('AC8 dry-run: lists the Codex steps and changes nothing at all', () => {
  const f = fixture();
  const before = hashTree(f.root);
  const r = run(f, ['install', '--dry-run']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hashTree(f.root), before);
  for (const word of ['config.toml', 'hooks.json', 'AGENTS.md', 'agent-monitor-handoff', 'fable-lead', 'verifier']) assert.ok(r.stdout.includes(word), `plan mentions ${word}`);
  const r2 = run(f, ['uninstall', '--dry-run']);
  assert.equal(r2.status, 0, r2.stderr);
  assert.deepEqual(hashTree(f.root), before);
});

test('AC8 install: config, MCP entry, six agents, skills, AGENTS.md, hooks, profile, Claude side', async () => {
  const cfg = await load('src/codex-config.js');
  const f = fixture();
  const r = run(f, ['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  // config.toml
  const c = read(f.codex, 'config.toml');
  assert.match(c, /# >>> agent-monitor\b/);
  assert.match(c, /project_doc_fallback_filenames = \["CLAUDE\.md"\]/);
  assert.match(c, /project_doc_max_bytes = 262144/);
  assert.match(c, /\[mcp_servers\.agent-monitor\]\s*\n\s*url = "http:\/\/127\.0\.0\.1:4749\/mcp"/);
  assert.ok(c.includes('# agent-monitor-replaced: project_doc_max_bytes = 1000'));
  assert.ok(c.includes('# agent-monitor-replaced: project_doc_fallback_filenames = ["OLD.md"]'));
  assert.ok(c.includes('model = "gpt-5.6-sol"') && c.includes('approval_policy = "on-request"'), 'other top-level keys kept');
  assert.ok(c.indexOf('# >>> agent-monitor\n') < c.indexOf("[projects.'C:"), 'key block sits before the first table');
  assert.ok(c.includes("[projects.'C:\\Users\\x']") && c.includes('[windows]'), 'tables kept');
  // agents
  for (const [name, role] of Object.entries(cfg.ROLES)) {
    const t = read(f.codex, 'agents', `${name}.toml`);
    assert.ok(t.startsWith('# Managed by Agent Monitor integrate'), `${name} header`);
    assert.equal(tomlStr(t, 'name'), name);
    assert.ok(tomlStr(t, 'description'));
    assert.equal(tomlStr(t, 'model'), role.model);
    assert.equal(tomlStr(t, 'model_reasoning_effort'), role.effort);
    const di = tomlStr(t, 'developer_instructions');
    assert.ok(di && di.length > 20, `${name} instructions`);
    if (name === 'fable-lead') assert.ok(!di.startsWith('---') && !/model: (opus|sonnet)/.test(di), 'no frontmatter'); // its source is the repo copy of the lead
    else if (name !== 'verifier' && name !== 'white-hat') assert.ok(di.includes(`Body of ${name}`) && !di.includes('model: sonnet'), 'body without frontmatter');
    else assert.ok(di.includes(`Skill body ${name}`));
    assert.ok(!/astra/i.test(t) && !/ultra/i.test(t) && !/service_tier|fast/i.test(t));
  }
  // skills
  for (const n of ['verifier', 'white-hat', 'other']) assert.ok(exists(f.agents, 'skills', n, 'SKILL.md'), `skill ${n} linked`);
  // AGENTS.md
  const ag = read(f.codex, 'AGENTS.md');
  assert.match(ag, /Ryan/);
  assert.match(ag, /tests_v2/);
  assert.match(ag, /percy/i);
  // hooks.json: foreign entry kept, ours added, fail-open shape
  const hk = JSON.parse(read(f.codex, 'hooks.json')).hooks;
  assert.deepEqual(hk.PreToolUse.find((e) => e.matcher === 'shell'), FOREIGN_HOOKS.hooks.PreToolUse[0]);
  for (const ev of ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionStart', 'SessionEnd']) {
    const ours = (hk[ev] || []).flatMap((e) => e.hooks || []).filter((h) => /agent-monitor\.js" hook codex/.test(h.command));
    assert.equal(ours.length, 1, `${ev} has one Agent Monitor entry`);
    assert.equal(ours[0].type, 'command');
    assert.ok(ours[0].timeout <= 5);
    assert.ok(/--port 4749/.test(ours[0].command), 'non-default port passed');
  }
  assert.ok(!hk.Notification, 'Codex has no Notification event');
  assert.ok((hk.PostToolUse.find((e) => e.hooks.some((h) => /hook codex/.test(h.command))) ?? {}).matcher === '*');
  // profile
  const p = read(f.codex, 'agent-monitor-handoff.config.toml');
  assert.equal(tomlStr(p, 'model'), cfg.HANDOFF.model);
  assert.equal(tomlStr(p, 'model_reasoning_effort'), cfg.HANDOFF.effort);
  assert.match(p, /approval_policy = "never"/);
  assert.match(p, /sandbox_mode = "workspace-write"/);
  assert.match(p, /network_access = true/);
  assert.match(p, /fast_mode = false/);
  assert.ok(!/astra|ultra/i.test(p));
  // Claude side
  const s = JSON.parse(read(f.home, 'settings.json'));
  assert.equal(s.autoContinueAtUsageLimit, false);
  for (const ev of ['UserPromptSubmit', 'StopFailure']) {
    assert.equal((s.hooks[ev] || []).flatMap((e) => e.hooks).filter((h) => /127\.0\.0\.1:4749\/hook/.test(h.command)).length, 1, `${ev} hook`);
  }
  // backups of changed pre-existing files
  assert.ok(baks(f.codex, 'config.toml').length >= 1, 'config.toml backup');
  assert.ok(baks(f.codex, 'hooks.json').length >= 1, 'hooks.json backup');
  // auth.json is never touched
  assert.equal(read(f.codex, 'auth.json'), SENTINEL);
  assert.ok(!r.stdout.includes('auth.json') && !r.stderr.includes('auth.json'));
  assert.ok(!exists(f.codex, 'auth.json.bak-agent-monitor') && !fs.readdirSync(f.codex).some((x) => x.startsWith('auth.json.')));
});

test('AC8: install is idempotent (no change, no extra backups) and keeps CRLF config endings', () => {
  const f = fixture({ crlf: true });
  assert.equal(run(f, ['install']).status, 0);
  const snap = hashTree(f.root);
  const r = run(f, ['install']);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(hashTree(f.root), snap, 'second install changes nothing');
  const c = fs.readFileSync(path.join(f.codex, 'config.toml'), 'utf8');
  assert.ok(!/(^|[^\r])\n/.test(c), 'no bare LF lines in a CRLF config');
});

test('AC8 uninstall: restores config.toml byte for byte, removes ours, keeps foreign hooks, never touches auth.json', () => {
  const f = fixture();
  assert.equal(run(f, ['install']).status, 0);
  const r = run(f, ['uninstall']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(f.codex, 'config.toml'), f.cfgText, 'config.toml back to the original');
  for (const n of ['fable-lead', 'sonnet-engineer', 'opus-engineer', 'haiku-engineer', 'verifier', 'white-hat']) assert.ok(!exists(f.codex, 'agents', `${n}.toml`), `${n}.toml removed`);
  assert.ok(!exists(f.codex, 'agent-monitor-handoff.config.toml'));
  assert.ok(!exists(f.codex, 'AGENTS.md'), 'managed AGENTS.md removed');
  const hk = JSON.parse(read(f.codex, 'hooks.json'));
  assert.deepEqual(hk, FOREIGN_HOOKS, 'foreign hooks exactly as before');
  for (const n of ['verifier', 'white-hat', 'other']) assert.ok(!exists(f.agents, 'skills', n), `link ${n} removed`);
  assert.ok(exists(f.home, 'skills', 'verifier', 'SKILL.md'), 'the source skill is untouched');
  const s = JSON.parse(read(f.home, 'settings.json'));
  assert.notEqual(s.autoContinueAtUsageLimit, false, 'our false value is removed');
  assert.ok(!JSON.stringify(s.hooks ?? {}).includes('127.0.0.1:4749'));
  assert.equal(read(f.codex, 'auth.json'), SENTINEL);
});

test('AC8: an existing non-link skill folder is left alone, an existing MCP table is not duplicated, a missing source agent is skipped', () => {
  const f = fixture();
  fs.mkdirSync(path.join(f.agents, 'skills', 'other'), { recursive: true });
  fs.writeFileSync(path.join(f.agents, 'skills', 'other', 'SKILL.md'), 'MINE');
  fs.appendFileSync(path.join(f.codex, 'config.toml'), '\n[mcp_servers.agent-monitor]\nurl = "http://127.0.0.1:1/mcp"\n');
  fs.rmSync(path.join(f.home, 'agents', 'haiku-engineer.md'));
  const r = run(f, ['install']);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.equal(read(f.agents, 'skills', 'other', 'SKILL.md'), 'MINE');
  const c = read(f.codex, 'config.toml');
  assert.equal(c.match(/\[mcp_servers\.agent-monitor\]/g).length, 1, 'one MCP table');
  assert.ok(!exists(f.codex, 'agents', 'haiku-engineer.toml'), 'missing source skipped');
  assert.ok(exists(f.codex, 'agents', 'fable-lead.toml'));
  assert.ok(/haiku-engineer/.test(r.stdout + r.stderr), 'the skip is reported');
});
