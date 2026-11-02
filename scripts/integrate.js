#!/usr/bin/env node
// Wires Agent Monitor into Claude Code (hooks in settings.json, the MCP server, an auto-start
// script, Ryan's four workflow files) and into Codex (config.toml blocks, agents, skills, AGENTS.md,
// hooks.json, the hand-off profile). It never spawns codex.
//   node scripts/integrate.js [install | uninstall] [--dry-run]
//   test overrides: --home <dir> --codex-home <dir> --agents-home <dir> --startup <dir> --claude <cmd> --port <n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkCodexConfig, DISABLED_FEATURES, HANDOFF, HANDOFF_PROFILE, ROLES } from '../src/codex-config.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['skills/fable-workflow/SKILL.md', 'skills/fable-workflow/tracking.md', 'skills/next/SKILL.md', 'agents/fable-lead.md'];
const WITH_MATCHER = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const EVENTS = [...WITH_MATCHER, 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'StopFailure'];
const TIMEOUT = 3;
const VBS_NAME = 'Agent Monitor.vbs';
const BAK = '.bak-agent-monitor-';

const isOurs = (cmd) => /127\.0\.0\.1:\d+\/hook/.test(cmd || '');
const isOrca = (cmd) => (cmd || '').includes('.orca/agent-hooks');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

function parseArgs(argv) {
  const o = { cmd: 'install', dryRun: false, home: path.join(os.homedir(), '.claude'), claude: 'claude', port: 4747, startup: null, codexHome: null, agentsHome: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'install' || a === 'uninstall') o.cmd = a;
    else if (a === '--dry-run') o.dryRun = true;
    else if (['--home', '--codex-home', '--agents-home', '--startup', '--claude', '--port'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--port') {
        o.port = Number(v);
        if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be 1..65535');
      } else o[a.slice(2).replace(/-(\w)/g, (_, c) => c.toUpperCase())] = a === '--claude' ? v : path.resolve(v);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  // next to --home by default, so a test home can never reach the real ~/.codex or ~/.agents
  o.codexHome ??= path.join(path.dirname(o.home), '.codex');
  o.agentsHome ??= path.join(path.dirname(o.home), '.agents');
  if (!o.startup) {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    o.startup = path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return o;
}

const hookCommand = (port) =>
  `curl -s --connect-timeout 0.1 -m 1 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hook || true`;

function ourEntry(event, port) {
  const entry = WITH_MATCHER.includes(event) ? { matcher: '*' } : {};
  entry.hooks = [{ type: 'command', command: hookCommand(port), timeout: TIMEOUT }];
  return entry;
}

// Removes entries whose commands match `drop`; keeps everything else as is.
function stripHooks(hooks, drop) {
  const out = {};
  for (const [event, entries] of Object.entries(hooks || {})) {
    const kept = [];
    for (const e of entries) {
      const inner = (e.hooks || []).filter((h) => !drop(h.command));
      if (inner.length === (e.hooks || []).length) kept.push(e);
      else if (inner.length) kept.push({ ...e, hooks: inner });
    }
    if (kept.length) out[event] = kept;
  }
  return out;
}

function planSettings(o, uninstall) {
  const file = path.join(o.home, 'settings.json');
  const exists = fs.existsSync(file);
  const text = exists ? fs.readFileSync(file, 'utf8') : '';
  const settings = exists ? JSON.parse(text) : {};
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const had = (re) => Object.values(settings.hooks || {}).flat().flatMap((e) => e.hooks || []).filter((h) => re(h.command)).length;
  let hooks = stripHooks(settings.hooks, (c) => isOurs(c) || (!uninstall && isOrca(c)));
  if (!uninstall) for (const ev of EVENTS) hooks[ev] = [...(hooks[ev] || []), ourEntry(ev, o.port)];
  const next = { ...settings };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  // Agent Monitor resumes the run in Codex at a usage limit, so Claude must not wait the limit out
  if (!uninstall) next.autoContinueAtUsageLimit = false;
  else if (next.autoContinueAtUsageLimit === false) delete next.autoContinueAtUsageLimit;
  const out = JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol;
  const orca = uninstall ? 0 : had(isOrca);
  return {
    file, text, out, changed: out !== text, exists,
    desc: uninstall
      ? `settings.json: remove our hook entries (${had(isOurs)} found) and autoContinueAtUsageLimit if false`
      : `settings.json: remove ${orca} Orca and ${had(isOurs)} old Agent Monitor hook entries, add ours for ${EVENTS.join(', ')} (timeout ${TIMEOUT}s), set autoContinueAtUsageLimit false`,
  };
}

function planFiles(o, uninstall) {
  return FILES.map((rel) => {
    const dst = path.join(o.home, ...rel.split('/'));
    const src = path.join(REPO, 'integration', 'claude-files', ...rel.split('/'));
    if (!uninstall) {
      const want = fs.readFileSync(src);
      const have = fs.existsSync(dst) ? fs.readFileSync(dst) : null;
      return { rel, dst, want, have, changed: !have || !have.equals(want) };
    }
    const dir = path.dirname(dst), base = path.basename(dst) + BAK;
    // the oldest backup is Ryan's original; later ones are earlier Agent Monitor installs
    const baks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith(base)).sort() : [];
    return { rel, dst, bak: baks.length ? path.join(dir, baks[0]) : null };
  });
}

function vbsText(o) {
  const q = (s) => s.replace(/"/g, '""');
  const lines = ['Set sh = CreateObject("WScript.Shell")', `sh.CurrentDirectory = "${q(REPO)}"`];
  if (o.port !== 4747) lines.push(`sh.Environment("Process")("AGENT_MONITOR_PORT") = "${o.port}"`);
  lines.push(`sh.Run """${q(process.execPath)}"" ""${q(path.join(REPO, 'bin', 'agent-monitor.js'))}"" serve", 0, False`);
  return lines.join('\r\n') + '\r\n';
}

function runClaude(o, args) {
  const win = process.platform === 'win32';
  const r = spawnSync(win ? `"${o.claude}"` : o.claude, args, { shell: win, encoding: 'utf8', timeout: 60000 });
  return { ok: r.status === 0, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}

const backupSettings = (file, ts) => fs.copyFileSync(file, `${file}.bak-${ts}`);

// ---- Codex side: config.toml blocks, agents, skills, AGENTS.md, hooks.json and the hand-off profile.
// Every step is a plan item {label, changed, apply(ts)} so dry-run, install and uninstall share one path.
const SIDE_MARK = '# Managed by Agent Monitor integrate';
const TOP = ['# >>> agent-monitor', '# <<< agent-monitor'];
const MCP = ['# >>> agent-monitor mcp', '# <<< agent-monitor mcp'];
const REPLACED = '# agent-monitor-replaced: ';
const DOC_KEY = /^\s*(project_doc_fallback_filenames|project_doc_max_bytes)\s*=/;
const CODEX_EVENTS = ['PreToolUse', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionStart', 'SessionEnd'];
const OUR_CODEX_HOOK = 'agent-monitor.js" hook codex';
const SKILL_ROLES = new Set(['verifier', 'white-hat']);
const PREAMBLE = [
  "You are a Codex agent in Ryan's Fable workflow. The instructions below were written for Claude Code, so read them like this:",
  '- The Agent tool means: spawn the named Codex agent (see ~/.codex/agents) and wait for it to finish.',
  '- The Skill tool means: read ~/.agents/skills/<name>/SKILL.md and follow it.',
  '- The Agent Monitor MCP tools (get_run, complete_stage, log, respond...) belong to the `agent-monitor` MCP server.',
  '- Ignore Claude model names (Fable, Opus, Sonnet, Haiku): your model is fixed by your agent file.',
  '',
  '',
].join('\n');

const clean = (p) => path.resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '');
const samePath = (a, b) => (process.platform === 'win32' ? clean(a).toLowerCase() === clean(b).toLowerCase() : clean(a) === clean(b));
const inside = (child, dir) => {
  const rel = path.relative(clean(dir), clean(child));
  return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
};
const readOr = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null);
const eolOf = (t) => (t && t.includes('\r\n') ? '\r\n' : '\n');
// the oldest backup is Ryan's original; later ones are earlier Agent Monitor installs
const oldestBackup = (f) => {
  const dir = path.dirname(f), base = path.basename(f) + BAK;
  const baks = fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.startsWith(base)).sort() : [];
  return baks.length ? fs.readFileSync(path.join(dir, baks[0]), 'utf8') : null;
};
const linkType = process.platform === 'win32' ? 'junction' : 'dir';

// One text file; `want` null = delete it (nothing of Ryan's is lost then). A rewritten existing file is backed up first unless `backup` is false.
function textItem(label, file, want, { backup = true } = {}) {
  const have = readOr(file);
  return {
    label,
    changed: want === null ? have !== null : have !== want,
    apply(ts) {
      if (backup && want !== null && have !== null) fs.copyFileSync(file, `${file}${BAK}${ts}`);
      if (want === null) fs.rmSync(file, { force: true });
      else {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, want);
      }
    },
  };
}

// Drops our marked blocks and restores the lines we commented out.
function stripToml(lines) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    const block = t === TOP[0] ? TOP : t === MCP[0] ? MCP : null;
    const end = block ? lines.findIndex((l, j) => j > i && l.trim() === block[1]) : -1;
    if (end < 0) { out.push(lines[i]); continue; }
    i = end;
  }
  return out.map((l) => (l.startsWith(REPLACED) ? l.slice(REPLACED.length) : l));
}

function configToml(o, uninstall) {
  const file = path.join(o.codexHome, 'config.toml');
  const text = readOr(file);
  const eol = eolOf(text);
  const lines = (text ?? '').split(/\r?\n/);
  const trailing = lines.at(-1) === '';
  if (trailing) lines.pop();
  const body = stripToml(lines);
  let note = '';
  if (!uninstall) {
    const header = body.findIndex((l) => /^\s*\[/.test(l));
    const topEnd = header < 0 ? body.length : header;
    // top-level project_doc keys of Ryan's are commented out (a multi-line array too) and restored on uninstall
    let cont = false;
    for (let i = 0; i < topEnd; i++) {
      if (!cont && !DOC_KEY.test(body[i])) continue;
      const val = cont ? body[i] : body[i].slice(body[i].indexOf('=') + 1);
      cont = cont ? !val.includes(']') : val.includes('[') && !val.includes(']');
      body[i] = REPLACED + body[i];
    }
    body.splice(topEnd, 0, TOP[0], 'project_doc_fallback_filenames = ["CLAUDE.md"]', 'project_doc_max_bytes = 262144', TOP[1]);
    if (body.some((l) => /^\s*\[mcp_servers\.(?:agent-monitor|"agent-monitor")(?:\]|\.)/.test(l))) note = ' (an [mcp_servers.agent-monitor] table already exists: left as is)';
    else body.push(MCP[0], '[mcp_servers.agent-monitor]', `url = ${JSON.stringify(`http://127.0.0.1:${o.port}/mcp`)}`, MCP[1]);
  }
  const want = uninstall && body.every((l) => l.trim() === '') ? null : body.join(eol) + (trailing || !text ? eol : '');
  return textItem(uninstall ? 'config.toml: remove our blocks and restore the replaced keys' : `config.toml: project_doc keys and the agent-monitor MCP server${note}`, file, want);
}

const bodyOf = (md) => md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const descOf = (md, name) => {
  const m = /^description:\s*(.+)$/m.exec(/^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1] ?? '');
  const v = m?.[1].trim().replace(/^(["'])(.*)\1$/, '$2');
  return v && !/^[>|]/.test(v) ? v : `${name} role (Agent Monitor)`;
};
// A Claude source as it will be once the Claude files are installed (our copy for those four, Ryan's home file for the rest).
function sourceText(o, rel) {
  const ours = path.join(REPO, 'integration', 'claude-files', ...rel.split('/'));
  return readOr(FILES.includes(rel) ? ours : path.join(o.home, ...rel.split('/')));
}

// A file we generate and mark: restored from Ryan's original (the oldest backup) or removed on uninstall.
function managedUninstall(label, file) {
  const have = readOr(file);
  if (have === null || !have.startsWith(SIDE_MARK)) return textItem(`${label}: not ours, left as is`, file, have);
  const bak = oldestBackup(file);
  return textItem(`${label}: ${bak === null ? 'remove' : 'restore the original'}`, file, bak, { backup: false });
}

function agentItems(o, uninstall, warn) {
  return Object.entries(ROLES).map(([name, r]) => {
    const file = path.join(o.codexHome, 'agents', `${name}.toml`);
    const label = `agents/${name}.toml`;
    if (uninstall) return managedUninstall(label, file);
    const md = sourceText(o, SKILL_ROLES.has(name) ? `skills/${name}/SKILL.md` : `agents/${name}.md`);
    if (md === null) {
      warn(`${label}: no Claude source for ${name}, skipped`);
      return textItem(`${label}: skipped (no source)`, file, readOr(file));
    }
    const toml = [
      SIDE_MARK, `name = ${JSON.stringify(name)}`, `description = ${JSON.stringify(descOf(md, name))}`,
      `model = ${JSON.stringify(r.model)}`, `model_reasoning_effort = ${JSON.stringify(r.effort)}`,
      `developer_instructions = ${JSON.stringify(PREAMBLE + bodyOf(md).trim() + '\n')}`, '',
    ].join('\n');
    return textItem(`${label}: write (${r.model}, ${r.effort})`, file, toml);
  });
}

// Skill folders to link: the ones already in Ryan's home plus the ones this install puts there.
function skillNames(o) {
  const names = new Set(FILES.filter((f) => f.startsWith('skills/')).map((f) => f.split('/')[1]));
  const dir = path.join(o.home, 'skills');
  if (fs.existsSync(dir)) for (const d of fs.readdirSync(dir)) if (fs.existsSync(path.join(dir, d, 'SKILL.md'))) names.add(d);
  return [...names];
}
const linkTarget = (p) => {
  try { return fs.lstatSync(p).isSymbolicLink() ? fs.readlinkSync(p) : null; } catch { return null; }
};

function skillItems(o, uninstall, warn) {
  const homeSkills = path.join(o.home, 'skills');
  const base = path.join(o.agentsHome, 'skills');
  const names = uninstall ? (fs.existsSync(base) ? fs.readdirSync(base) : []) : skillNames(o);
  const items = [];
  for (const name of names) {
    const link = path.join(base, name), src = path.join(homeSkills, name);
    const cur = linkTarget(link);
    const add = (what, changed, apply = () => {}) => items.push({ label: `~/.agents/skills/${name}: ${what}`, changed, apply });
    const mk = () => { fs.mkdirSync(base, { recursive: true }); fs.symlinkSync(src, link, linkType); };
    if (uninstall) {
      if (cur !== null && inside(cur, homeSkills)) add('remove link', true, () => fs.unlinkSync(link));
    } else if (cur !== null && samePath(cur, src)) add('linked [no change]', false);
    else if (cur !== null && !inside(cur, homeSkills)) { warn(`~/.agents/skills/${name} is a link to somewhere else, left as is`); add('left as is', false); }
    else if (cur !== null) add('relink', true, () => { fs.unlinkSync(link); mk(); });
    else if (fs.existsSync(link)) { warn(`~/.agents/skills/${name} is a real folder, left as is`); add('left as is', false); }
    else add('link', true, mk);
  }
  return items;
}

function agentsMd(o, uninstall) {
  const file = path.join(o.codexHome, 'AGENTS.md');
  const ours = fs.readFileSync(path.join(REPO, 'integration', 'codex-files', 'AGENTS.md'), 'utf8');
  if (!uninstall) return textItem("AGENTS.md: Ryan's standing rules", file, ours);
  const have = readOr(file);
  const bak = oldestBackup(file);
  if (bak !== null) return textItem('AGENTS.md: restore the original', file, bak, { backup: false });
  return textItem(have === ours ? 'AGENTS.md: remove' : 'AGENTS.md: not ours, left as is', file, have === ours ? null : have, { backup: false });
}

function hooksJson(o, uninstall) {
  const file = path.join(o.codexHome, 'hooks.json');
  const text = readOr(file);
  const eol = eolOf(text);
  const cur = text ? JSON.parse(text) : {};
  const hooks = stripHooks(cur.hooks, (c) => (c || '').includes(OUR_CODEX_HOOK));
  const cmd = `"${process.execPath.replace(/\\/g, '/')}" "${path.join(REPO, 'bin', 'agent-monitor.js').replace(/\\/g, '/')}" hook codex${o.port === 4747 ? '' : ` --port ${o.port}`}`;
  if (!uninstall) {
    for (const ev of CODEX_EVENTS) {
      const entry = ev === 'PreToolUse' || ev === 'PostToolUse' ? { matcher: '*' } : {};
      hooks[ev] = [...(hooks[ev] || []), { ...entry, hooks: [{ type: 'command', command: cmd, timeout: TIMEOUT }] }];
    }
  }
  const next = { ...cur };
  if (Object.keys(hooks).length) next.hooks = hooks;
  else delete next.hooks;
  // an uninstall that leaves nothing behind removes the file we created
  const want = text === null && uninstall ? null : uninstall && !Object.keys(next).length ? null : JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol;
  return textItem(uninstall ? 'hooks.json: remove our hook entries' : `hooks.json: our hooks for ${CODEX_EVENTS.join(', ')} (Ryan approves them once with /hooks in Codex)`, file, want);
}

function profileItem(o, uninstall) {
  const file = path.join(o.codexHome, `${HANDOFF_PROFILE}.config.toml`);
  const label = `${HANDOFF_PROFILE}.config.toml`;
  if (uninstall) return managedUninstall(label, file);
  const toml = [
    SIDE_MARK, `model = ${JSON.stringify(HANDOFF.model)}`, `model_reasoning_effort = ${JSON.stringify(HANDOFF.effort)}`,
    'approval_policy = "never"', 'sandbox_mode = "workspace-write"', '', '[sandbox_workspace_write]', 'network_access = true', '',
    '[features]', ...DISABLED_FEATURES.map((f) => `${f} = false`), '',
  ].join('\n');
  return textItem(`${label}: write (${HANDOFF.model}, ${HANDOFF.effort}, no fast tier)`, file, toml);
}

function planCodex(o, uninstall, warn) {
  return [configToml(o, uninstall), ...agentItems(o, uninstall, warn), ...skillItems(o, uninstall, warn), agentsMd(o, uninstall), hooksJson(o, uninstall), profileItem(o, uninstall)];
}

function main(argv) {
  const o = parseArgs(argv);
  const uninstall = o.cmd === 'uninstall';
  const ts = stamp();
  const say = (m) => console.log(m);
  const mcpUrl = `http://127.0.0.1:${o.port}/mcp`;
  const mcpArgs = uninstall ? ['mcp', 'remove', '--scope', 'user', 'agent-monitor']
    : ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agent-monitor', mcpUrl];

  const warnings = [];
  const warn = (m) => warnings.push(m);
  if (!uninstall) {
    const errors = checkCodexConfig();
    if (errors.length) throw new Error(`Codex config is not allowed: ${errors.join('; ')}`);
  }
  const s = planSettings(o, uninstall);
  const codex = planCodex(o, uninstall, warn);
  const files = planFiles(o, uninstall);
  const vbs = path.join(o.startup, VBS_NAME);
  const vbsWant = vbsText(o);
  const vbsHave = fs.existsSync(vbs) ? fs.readFileSync(vbs, 'utf8') : null;

  if (o.dryRun) {
    say(`DRY RUN: ${o.cmd} (nothing is written or run)`);
    say(`- ${s.desc}${s.changed ? '' : ' [no change]'}${s.changed && s.exists ? `; backup ${path.basename(s.file)}.bak-${ts}` : ''}`);
    say(`- MCP: run \`claude mcp get agent-monitor\`, then \`claude ${mcpArgs.join(' ')}\` ${uninstall ? 'if it is registered' : 'if it is not'}`);
    say(`- ${uninstall ? 'delete' : 'write'} ${vbs}${uninstall ? '' : vbsHave === vbsWant ? ' [no change]' : ''}`);
    for (const f of files) {
      if (uninstall) say(`- ${f.rel}: ${f.bak ? `restore from ${path.basename(f.bak)}` : 'no backup, leave as is'}`);
      else say(`- ${f.rel}: ${f.changed ? `write${f.have ? ` (backup ${path.basename(f.dst)}${BAK}${ts})` : ''}` : '[no change]'}`);
    }
    for (const c of codex) say(`- Codex ${c.label}${c.changed ? '' : ' [no change]'}`);
    for (const w of warnings) say(`- warning: ${w}`);
    return 0;
  }

  let failed = false;
  // settings.json
  if (s.changed) {
    if (s.exists) backupSettings(s.file, ts);
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    fs.writeFileSync(s.file, s.out);
    say(s.desc);
  } else say('settings.json: no change');

  // MCP server
  const registered = runClaude(o, ['mcp', 'get', 'agent-monitor']).ok;
  if (registered === uninstall) {
    const r = runClaude(o, mcpArgs);
    if (r.ok) say(`MCP: ${uninstall ? 'removed' : 'added'} agent-monitor`);
    else { failed = true; console.error(`MCP: \`claude ${mcpArgs.join(' ')}\` failed: ${r.out}`); }
  } else say(`MCP: ${uninstall ? 'not registered' : 'already registered'}`);

  // auto-start
  if (uninstall) {
    if (vbsHave !== null) { fs.rmSync(vbs); say(`Removed ${vbs}`); } else say('Auto-start: not installed');
  } else if (vbsHave !== vbsWant) {
    fs.mkdirSync(o.startup, { recursive: true });
    fs.writeFileSync(vbs, vbsWant);
    say(`Wrote ${vbs}`);
  } else say('Auto-start: no change');

  // workflow files
  for (const f of files) {
    if (uninstall) {
      if (f.bak) { fs.copyFileSync(f.bak, f.dst); say(`${f.rel}: restored from ${path.basename(f.bak)}`); }
      else say(`${f.rel}: no backup, left as is`);
    } else if (f.changed) {
      if (f.have) fs.copyFileSync(f.dst, `${f.dst}${BAK}${ts}`);
      fs.mkdirSync(path.dirname(f.dst), { recursive: true });
      fs.writeFileSync(f.dst, f.want);
      say(`${f.rel}: written${f.have ? ' (backup kept)' : ''}`);
    } else say(`${f.rel}: no change`);
  }
  // Codex side
  for (const c of codex) {
    if (c.changed) c.apply(ts);
    say(`Codex ${c.label}${c.changed ? '' : ' [no change]'}`);
  }
  for (const w of warnings) console.error(`warning: ${w}`);
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`integrate: ${e.message}`);
  process.exitCode = 1;
}
