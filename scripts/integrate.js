#!/usr/bin/env node
// Wires Agent Monitor into Claude Code: hooks in settings.json, the MCP server,
// an auto-start script and Ryan's four workflow files.
//   node scripts/integrate.js [install | uninstall] [--dry-run]
//   test overrides: --home <dir> --startup <dir> --claude <cmd> --port <n>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['skills/fable-workflow/SKILL.md', 'skills/fable-workflow/tracking.md', 'skills/next/SKILL.md', 'agents/fable-lead.md'];
const WITH_MATCHER = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest'];
const EVENTS = [...WITH_MATCHER, 'SubagentStart', 'SubagentStop', 'Notification', 'Stop', 'SessionEnd'];
const TIMEOUT = 3;
const VBS_NAME = 'Agent Monitor.vbs';
const BAK = '.bak-agent-monitor-';

const isOurs = (cmd) => /127\.0\.0\.1:\d+\/hook/.test(cmd || '');
const isOrca = (cmd) => (cmd || '').includes('.orca/agent-hooks');
const stamp = (d = new Date()) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

function parseArgs(argv) {
  const o = { cmd: 'install', dryRun: false, home: path.join(os.homedir(), '.claude'), claude: 'claude', port: 4747, startup: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === 'install' || a === 'uninstall') o.cmd = a;
    else if (a === '--dry-run') o.dryRun = true;
    else if (['--home', '--startup', '--claude', '--port'].includes(a)) {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--port') {
        o.port = Number(v);
        if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) throw new Error('--port must be 1..65535');
      } else o[a.slice(2)] = a === '--claude' ? v : path.resolve(v);
    } else throw new Error(`Unknown argument: ${a}`);
  }
  if (!o.startup) {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    o.startup = path.join(base, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
  }
  return o;
}

const hookCommand = (port) =>
  `curl -s --connect-timeout 0.3 -m 1 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hook || true`;

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
  const out = JSON.stringify(next, null, 2).replace(/\n/g, eol) + eol;
  const orca = uninstall ? 0 : had(isOrca);
  return {
    file, text, out, changed: out !== text, exists,
    desc: uninstall
      ? `settings.json: remove our hook entries (${had(isOurs)} found)`
      : `settings.json: remove ${orca} Orca and ${had(isOurs)} old Agent Monitor hook entries, add ours for ${EVENTS.join(', ')} (timeout ${TIMEOUT}s)`,
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

function main(argv) {
  const o = parseArgs(argv);
  const uninstall = o.cmd === 'uninstall';
  const ts = stamp();
  const say = (m) => console.log(m);
  const mcpUrl = `http://127.0.0.1:${o.port}/mcp`;
  const mcpArgs = uninstall ? ['mcp', 'remove', '--scope', 'user', 'agent-monitor']
    : ['mcp', 'add', '--scope', 'user', '--transport', 'http', 'agent-monitor', mcpUrl];

  const s = planSettings(o, uninstall);
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
  return failed ? 1 : 0;
}

try {
  process.exitCode = main(process.argv.slice(2));
} catch (e) {
  console.error(`integrate: ${e.message}`);
  process.exitCode = 1;
}
