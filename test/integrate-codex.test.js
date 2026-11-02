import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { HANDOFF_PROFILE, ROLES } from '../src/codex-config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = path.join(ROOT, 'scripts', 'integrate.js');
const BAK = '.bak-agent-monitor-';
const AGENT_ROLES = ['fable-lead', 'sonnet-engineer', 'opus-engineer', 'haiku-engineer'];
const SKILL_ROLES = ['verifier', 'white-hat'];
const SENTINEL = 'sentinel-not-a-real-credential\n';

const CONFIG = [
  'model = "gpt-5.6-sol"',
  'project_doc_max_bytes = 1000',
  'project_doc_fallback_filenames = [',
  '  "README.md",',
  ']',
  'personality = "friendly"',
  '',
  "[projects.'C:\\x']",
  'trust_level = "trusted"',
  '',
  '[tui]',
  'theme = "dark"',
  '',
].join('\n');
const HOOKS = { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'node mine.js', timeout: 5 }] }] }, other: 1 };

let tmp, home, codexHome, agentsHome, startup, claude, log;

function makeFakeClaude() {
  const js = path.join(tmp, 'fake-claude.js');
  const state = path.join(tmp, 'mcp-registered');
  fs.writeFileSync(js, `
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(a) + '\\n');
if (a[1] === 'add') fs.writeFileSync(${JSON.stringify(state)}, '1');
if (a[1] === 'remove') fs.rmSync(${JSON.stringify(state)}, { force: true });
if (a[1] === 'get') process.exit(fs.existsSync(${JSON.stringify(state)}) ? 0 : 1);
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

const write = (f, text) => {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
};
const read = (f) => fs.readFileSync(f, 'utf8');
const cx = (...p) => path.join(codexHome, ...p);
const run = (...args) => spawnSync(process.execPath, [SCRIPT, ...args, '--home', home, '--codex-home', codexHome, '--agents-home', agentsHome, '--startup', startup, '--claude', claude], { encoding: 'utf8' });
const backups = (dir, prefix) => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(prefix)) : []);
// every file under codex-home (skill links are not followed) -> text; plus agents-home link targets
function snapshot() {
  const out = {};
  const walk = (d, base) => {
    if (!fs.existsSync(d)) return;
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) out[`${base}/${e.name}`] = `-> ${fs.readlinkSync(p)}`;
      else if (e.isDirectory()) walk(p, `${base}/${e.name}`);
      else out[`${base}/${e.name}`] = read(p);
    }
  };
  walk(codexHome, 'codex');
  walk(agentsHome, 'agents');
  return out;
}
const tomlString = (text, key) => JSON.parse(new RegExp(`^${key} = (".*")$`, 'm').exec(text)[1]);

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-int-codex-'));
  home = path.join(tmp, 'claude-home');
  codexHome = path.join(tmp, 'codex-home');
  agentsHome = path.join(tmp, 'agents-home');
  startup = path.join(tmp, 'startup');
  log = path.join(tmp, 'claude-calls.log');
  write(path.join(home, 'settings.json'), '{}\n');
  for (const n of AGENT_ROLES) write(path.join(home, 'agents', `${n}.md`), `---\nname: ${n}\ndescription: The ${n} role.\nmodel: sonnet\n---\n\nBody of ${n} with "quotes" and a \\ slash.\nSecond line.\n`);
  for (const n of SKILL_ROLES) write(path.join(home, 'skills', n, 'SKILL.md'), `---\nname: ${n}\ndescription: The ${n} skill.\n---\n\nSkill body ${n}.\n`);
  write(path.join(home, 'skills', 'other', 'SKILL.md'), '---\nname: other\ndescription: x\n---\nother\n');
  write(path.join(home, 'skills', 'not-a-skill', 'README.md'), 'no SKILL.md here\n');
  write(cx('config.toml'), CONFIG);
  write(cx('hooks.json'), JSON.stringify(HOOKS, null, 2) + '\n');
  write(cx('auth.json'), SENTINEL);
  claude = makeFakeClaude();
});
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('install adds the config.toml blocks, comments out Ryan\'s own project_doc keys and keeps the rest', () => {
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  const t = read(cx('config.toml'));
  const lines = t.split('\n');
  const start = lines.indexOf('# >>> agent-monitor');
  const firstTable = lines.findIndex((l) => l.startsWith('['));
  assert.ok(start >= 0 && start < firstTable, 'top block sits before the first table');
  assert.ok(t.includes('project_doc_fallback_filenames = ["CLAUDE.md"]\nproject_doc_max_bytes = 262144\n# <<< agent-monitor\n'));
  assert.ok(t.includes('# agent-monitor-replaced: project_doc_max_bytes = 1000'));
  assert.ok(t.includes('# agent-monitor-replaced:   "README.md",'), 'multi-line array commented out too');
  assert.ok(t.endsWith('# >>> agent-monitor mcp\n[mcp_servers.agent-monitor]\nurl = "http://127.0.0.1:4747/mcp"\n# <<< agent-monitor mcp\n'));
  for (const keep of ['model = "gpt-5.6-sol"', 'personality = "friendly"', "[projects.'C:\\x']", 'trust_level = "trusted"', '[tui]', 'theme = "dark"']) assert.ok(t.includes(keep), keep);
  assert.equal(backups(codexHome, `config.toml${BAK}`).length, 1);
  assert.equal(read(path.join(codexHome, backups(codexHome, `config.toml${BAK}`)[0])), CONFIG);
});

test('install keeps an existing [mcp_servers.agent-monitor] table and says so', () => {
  write(cx('config.toml'), CONFIG + '\n[mcp_servers.agent-monitor]\nurl = "http://example.test/mcp"\n');
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  const t = read(cx('config.toml'));
  assert.equal(t.match(/\[mcp_servers\.agent-monitor\]/g).length, 1);
  assert.ok(!t.includes('# >>> agent-monitor mcp'));
  assert.match(r.stdout, /already exists: left as is/);
  run('uninstall');
  assert.ok(read(cx('config.toml')).includes('http://example.test/mcp'));
});

test('install writes one agent TOML per role with the pinned model, effort and translated instructions', () => {
  assert.equal(run('install').status, 0);
  for (const [name, r] of Object.entries(ROLES)) {
    const t = read(cx('agents', `${name}.toml`));
    assert.equal(t.split('\n')[0], '# Managed by Agent Monitor integrate');
    assert.equal(tomlString(t, 'name'), name);
    const desc = tomlString(t, 'description');
    if (name === 'fable-lead') assert.match(desc, /^Engineering lead for Ryan/);
    else assert.equal(desc, SKILL_ROLES.includes(name) ? `The ${name} skill.` : `The ${name} role.`);
    assert.equal(tomlString(t, 'model'), r.model);
    assert.equal(tomlString(t, 'model_reasoning_effort'), r.effort);
    const instr = tomlString(t, 'developer_instructions');
    assert.match(instr, /Agent tool means: spawn the named Codex agent/);
    assert.ok(!instr.includes('model: sonnet') && !instr.includes('---'), 'frontmatter stripped');
  }
  // the four workflow files come from this repo's copy, the others from Ryan's home
  assert.match(tomlString(read(cx('agents', 'fable-lead.toml')), 'developer_instructions'), /You are the engineering lead for one task/);
  assert.match(tomlString(read(cx('agents', 'sonnet-engineer.toml')), 'developer_instructions'), /Body of sonnet-engineer with "quotes" and a \\ slash\.\nSecond line\./);
  assert.match(tomlString(read(cx('agents', 'verifier.toml')), 'developer_instructions'), /Skill body verifier\./);
});

test('a missing Claude source is skipped with a warning', () => {
  fs.rmSync(path.join(home, 'agents', 'haiku-engineer.md'));
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(cx('agents', 'haiku-engineer.toml')));
  assert.match(r.stderr, /haiku-engineer.*skipped/);
  assert.ok(fs.existsSync(cx('agents', 'sonnet-engineer.toml')));
});

test('install links every skill that has a SKILL.md, leaves a real folder and a foreign link alone', () => {
  write(path.join(agentsHome, 'skills', 'other', 'SKILL.md'), 'Ryan\'s own folder\n');
  const foreign = path.join(tmp, 'foreign-skill');
  write(path.join(foreign, 'SKILL.md'), 'foreign\n');
  fs.mkdirSync(path.join(agentsHome, 'skills'), { recursive: true });
  fs.symlinkSync(foreign, path.join(agentsHome, 'skills', 'verifier'), process.platform === 'win32' ? 'junction' : 'dir');
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  for (const n of ['fable-workflow', 'next', 'white-hat']) {
    const link = path.join(agentsHome, 'skills', n);
    assert.ok(fs.lstatSync(link).isSymbolicLink(), n);
    assert.ok(fs.existsSync(path.join(link, 'SKILL.md')), `${n} resolves`);
  }
  assert.ok(!fs.existsSync(path.join(agentsHome, 'skills', 'not-a-skill')));
  assert.equal(read(path.join(agentsHome, 'skills', 'other', 'SKILL.md')), 'Ryan\'s own folder\n');
  assert.ok(!fs.lstatSync(path.join(agentsHome, 'skills', 'other')).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(agentsHome, 'skills', 'verifier', 'SKILL.md')) && read(path.join(agentsHome, 'skills', 'verifier', 'SKILL.md')) === 'foreign\n');
  assert.match(r.stderr, /skills\/other is a real folder/);
  assert.match(r.stderr, /skills\/verifier is a link to somewhere else/);
});

test('install writes AGENTS.md, the hand-off profile and the hooks.json entries next to Ryan\'s own', () => {
  assert.equal(run('install').status, 0);
  assert.equal(read(cx('AGENTS.md')), read(path.join(ROOT, 'integration', 'codex-files', 'AGENTS.md')));
  const prof = read(cx(`${HANDOFF_PROFILE}.config.toml`));
  assert.match(prof, /^model = "gpt-5\.6-sol"$/m);
  assert.match(prof, /^model_reasoning_effort = "high"$/m);
  assert.match(prof, /^approval_policy = "never"$/m);
  assert.match(prof, /^sandbox_mode = "workspace-write"$/m);
  assert.match(prof, /\[sandbox_workspace_write\]\nnetwork_access = true/);
  assert.match(prof, /\[features\]\nfast_mode = false/);
  const h = JSON.parse(read(cx('hooks.json')));
  assert.equal(h.other, 1);
  assert.deepEqual(h.hooks.PreToolUse[0], HOOKS.hooks.PreToolUse[0], 'Ryan\'s entry first and untouched');
  assert.deepEqual(Object.keys(h.hooks).sort(), ['PostToolUse', 'PreToolUse', 'SessionEnd', 'SessionStart', 'Stop', 'SubagentStart', 'SubagentStop']);
  for (const [ev, entries] of Object.entries(h.hooks)) {
    const ours = entries.filter((e) => e.hooks.some((x) => x.command.includes('agent-monitor.js" hook codex')));
    assert.equal(ours.length, 1, ev);
    const cmd = ours[0].hooks[0];
    assert.equal(cmd.type, 'command');
    assert.equal(cmd.timeout, 3);
    assert.ok(cmd.command.startsWith(`"${process.execPath.replace(/\\/g, '/')}" "${path.join(ROOT, 'bin', 'agent-monitor.js').replace(/\\/g, '/')}" hook codex`));
    assert.ok(!cmd.command.includes('--port'), 'default port needs no flag');
    assert.equal(ours[0].matcher, ev === 'PreToolUse' || ev === 'PostToolUse' ? '*' : undefined);
  }
});

test('a non-default --port reaches the MCP url and the hook command', () => {
  assert.equal(run('install', '--port', '4800').status, 0);
  assert.ok(read(cx('config.toml')).includes('url = "http://127.0.0.1:4800/mcp"'));
  assert.ok(read(cx('hooks.json')).includes('hook codex --port 4800'));
  assert.equal(run('install').status, 0);
  assert.ok(read(cx('config.toml')).includes('4747/mcp') && !read(cx('config.toml')).includes('4800'));
  assert.ok(!read(cx('hooks.json')).includes('--port'));
});

test('install never writes astra, a fast tier or ultra effort, and never touches auth.json', () => {
  assert.equal(run('install').status, 0);
  const files = Object.entries(snapshot()).filter(([k]) => !k.endsWith('auth.json') && !k.includes(BAK) && !k.startsWith('agents/') && !k.endsWith('/AGENTS.md'));
  assert.match(read(cx('AGENTS.md')), /Never use `gpt-6-astra`.*ultra/s);
  assert.ok(files.length > 8);
  for (const [k, v] of files) {
    assert.ok(!/astra/i.test(v), `${k} mentions astra`);
    assert.ok(!/"ultra"|\bultrafast\b|service_tier/i.test(v), `${k} has ultra or a fast tier`);
    assert.ok(!/"fast"|^\s*fast\s*=|fast_mode = true/im.test(v), `${k} enables fast`);
  }
  assert.equal(read(cx('auth.json')), SENTINEL);
  assert.equal(run('uninstall').status, 0);
  assert.equal(read(cx('auth.json')), SENTINEL);
  assert.deepEqual(backups(codexHome, `auth.json${BAK}`), []);
  assert.ok(!/auth\.json/.test(read(SCRIPT)), 'integrate never names auth.json');
});

test('a second install changes nothing and makes no new backup', () => {
  assert.equal(run('install').status, 0);
  const first = snapshot();
  const r = run('install');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(snapshot(), first);
  assert.match(r.stdout, /config\.toml.*\[no change\]/);
});

test('uninstall puts config.toml, hooks.json and the config back and removes everything we made', () => {
  const before = snapshot();
  assert.equal(run('install').status, 0);
  const r = run('uninstall');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(read(cx('config.toml')), CONFIG, 'config.toml byte-identical');
  assert.deepEqual(JSON.parse(read(cx('hooks.json'))), HOOKS);
  assert.equal(read(cx('auth.json')), SENTINEL);
  for (const n of Object.keys(ROLES)) assert.ok(!fs.existsSync(cx('agents', `${n}.toml`)), n);
  for (const f of ['AGENTS.md', `${HANDOFF_PROFILE}.config.toml`]) assert.ok(!fs.existsSync(cx(f)), f);
  assert.deepEqual(fs.existsSync(path.join(agentsHome, 'skills')) ? fs.readdirSync(path.join(agentsHome, 'skills')) : [], []);
  // the skill sources in the Claude home are still there
  assert.ok(fs.existsSync(path.join(home, 'skills', 'verifier', 'SKILL.md')));
  const after = Object.fromEntries(Object.entries(snapshot()).filter(([k]) => !k.includes(BAK)));
  assert.deepEqual(after, before);
});

test('uninstall restores an original AGENTS.md, agent TOML and profile from the oldest backup', () => {
  write(cx('AGENTS.md'), 'Ryan\'s own rules\n');
  write(cx('agents', 'verifier.toml'), 'name = "verifier"\n# mine\n');
  write(cx(`${HANDOFF_PROFILE}.config.toml`), 'model = "mine"\n');
  assert.equal(run('install').status, 0);
  assert.notEqual(read(cx('AGENTS.md')), 'Ryan\'s own rules\n');
  assert.equal(backups(cx('agents'), `verifier.toml${BAK}`).length, 1);
  assert.equal(run('uninstall').status, 0);
  assert.equal(read(cx('AGENTS.md')), 'Ryan\'s own rules\n');
  assert.equal(read(cx('agents', 'verifier.toml')), 'name = "verifier"\n# mine\n');
  assert.equal(read(cx(`${HANDOFF_PROFILE}.config.toml`)), 'model = "mine"\n');
});

test('install on an empty codex home creates the files and uninstall removes them again', () => {
  fs.rmSync(codexHome, { recursive: true });
  assert.equal(run('install').status, 0);
  assert.ok(read(cx('config.toml')).includes('# >>> agent-monitor\n'));
  assert.ok(fs.existsSync(cx('hooks.json')));
  assert.equal(run('uninstall').status, 0);
  assert.deepEqual(Object.keys(snapshot()), [], 'nothing of ours is left');
});

test('CRLF config.toml keeps its line endings', () => {
  write(cx('config.toml'), CONFIG.replace(/\n/g, '\r\n'));
  assert.equal(run('install').status, 0);
  const t = read(cx('config.toml'));
  assert.ok(!/[^\r]\n/.test(t), 'no bare LF');
  assert.equal(run('uninstall').status, 0);
  assert.equal(read(cx('config.toml')), CONFIG.replace(/\n/g, '\r\n'));
});

test('--dry-run lists every Codex step and the Claude additions, and writes nothing', () => {
  const before = snapshot();
  const claudeBefore = read(path.join(home, 'settings.json'));
  for (const args of [['--dry-run'], ['install', '--dry-run']]) {
    const r = run(...args);
    assert.equal(r.status, 0, r.stderr);
    for (const re of [/Codex config\.toml/, /UserPromptSubmit, StopFailure/, /autoContinueAtUsageLimit/, /Codex hooks\.json/, /Codex AGENTS\.md/, new RegExp(`Codex ${HANDOFF_PROFILE}\\.config\\.toml`), /Codex ~\/\.agents\/skills\/verifier: link/]) assert.match(r.stdout, re);
    for (const n of Object.keys(ROLES)) assert.match(r.stdout, new RegExp(`Codex agents/${n}\\.toml`));
  }
  assert.deepEqual(snapshot(), before);
  assert.equal(read(path.join(home, 'settings.json')), claudeBefore);
  assert.ok(!fs.existsSync(path.join(agentsHome, 'skills')));
  assert.ok(!fs.existsSync(log), 'claude was not run');
  assert.match(run('uninstall', '--dry-run').stdout, /Codex config\.toml: remove our blocks/);
});

test('a config that names astra, ultra or a fast tier aborts the install before anything is written', () => {
  const alt = path.join(tmp, 'alt');
  fs.mkdirSync(path.join(alt, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(alt, 'src'));
  fs.copyFileSync(SCRIPT, path.join(alt, 'scripts', 'integrate.js'));
  const cfg = read(path.join(ROOT, 'src', 'codex-config.js'));
  for (const [bad, want] of [[cfg.replace("'gpt-5.6'", "'gpt-6-astra'"), /astra/], [cfg.replace("effort: 'low'", "effort: 'ultra'"), /ultra/], [cfg.replace("effort: 'low'", "effort: 'fast'"), /fast/]]) {
    assert.notEqual(bad, cfg);
    fs.writeFileSync(path.join(alt, 'src', 'codex-config.js'), bad);
    const before = snapshot();
    const r = spawnSync(process.execPath, [path.join(alt, 'scripts', 'integrate.js'), 'install', '--home', home, '--codex-home', codexHome, '--agents-home', agentsHome, '--startup', startup, '--claude', claude], { encoding: 'utf8' });
    assert.equal(r.status, 1);
    assert.match(r.stderr, want);
    assert.deepEqual(snapshot(), before);
    assert.equal(read(path.join(home, 'settings.json')), '{}\n');
    assert.ok(!fs.existsSync(startup));
  }
});

test('without --codex-home the defaults sit next to --home, never in the real home', () => {
  const r = spawnSync(process.execPath, [SCRIPT, 'install', '--dry-run', '--home', home, '--startup', startup, '--claude', claude], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!fs.existsSync(path.join(tmp, '.codex')));
});
