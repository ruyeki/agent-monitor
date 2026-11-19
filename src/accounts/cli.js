// `agent-monitor accounts add|list|use|remove|refresh`. Exit 0 ok, 1 failure, 2 usage error. Never prints a token.
import { createAccounts } from './index.js';
import { NAME } from './state.js';

const USAGE = 'Usage: agent-monitor accounts add <name> [--current] [--email <e>] | list | use <name> | remove <name> | refresh [<name>]';
const pad = (n) => String(n).padStart(2, '0');
const when = (ms) => { if (ms == null) return '-'; const d = new Date(ms); return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const day = (v) => { const d = new Date(v); return v && !Number.isNaN(d.getTime()) ? `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` : '-'; };
const pct = (v) => (v == null ? '-' : `${Math.round(v)}%`);

function status(r) {
  if (!r.saved) return 'no saved login';
  if (r.limitedUntil != null) return `limited until ${when(r.limitedUntil)}`;
  if (r.active) return 'active';
  return r.reading ? 'available' : 'no reading';
}

// Plain table, one row per account; '*' marks the live login.
export function formatList(rows) {
  if (!rows.length) return ['No accounts saved. Add one with: agent-monitor accounts add <name> [--current]'];
  const head = ['', 'NAME', '5H', '7D', 'LEFT', '5H RESETS', '7D RESETS', 'STATUS', 'REFRESH BY'];
  const body = rows.map((r) => [r.active ? '*' : '', r.name, pct(r.fiveHour), pct(r.sevenDay), pct(r.left),
    when(r.fiveHourResetsAt), when(r.sevenDayResetsAt), status(r), day(r.refreshExpiresAt)]);
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  return [head, ...body].map((cols) => cols.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd());
}

function parse(argv) {
  const args = argv[0] === 'accounts' ? argv.slice(1) : [...argv];
  const [cmd, ...rest] = args;
  const pos = [];
  const opts = { current: false, email: null };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--current') opts.current = true;
    else if (rest[i] === '--email') { opts.email = rest[++i]; if (!opts.email) return null; }
    else if (rest[i].startsWith('-')) return null;
    else pos.push(rest[i]);
  }
  const want = { add: [1, 1], list: [0, 0], use: [1, 1], remove: [1, 1], refresh: [0, 1] }[cmd];
  if (!want || pos.length < want[0] || pos.length > want[1]) return null;
  if (cmd !== 'add' && (opts.current || opts.email)) return null;
  if (pos[0] !== undefined && !NAME.test(pos[0])) return null;
  return { cmd, name: pos[0] ?? null, opts };
}

// argv: the words after `accounts` (a leading 'accounts' is skipped). out/err: line printers (default: the console).
export async function runAccountsCli(argv, { dataDir, home, claudeJson, vault, claude = null, out = console.log, err = console.error } = {}) {
  const say = typeof out === 'function' ? out : (s) => out.write(`${s}\n`);
  const warn = typeof err === 'function' ? err : (s) => err.write(`${s}\n`);
  const p = parse(argv ?? []);
  if (!p) { warn(USAGE); return 2; }
  const m = createAccounts({ dataDir, home, claudeJson, vault, claude });
  try {
    switch (p.cmd) {
      case 'list':
        for (const line of formatList(m.list())) say(line);
        { const why = m.liveReason(); if (why) say(`Live login: unknown account (${why})`); }
        return 0;
      case 'add': {
        if (!p.opts.current) say(`Signing in to Claude for "${p.name}" in a separate Claude Code profile...`);
        const r = await m.add(p.name, p.opts);
        say(`Saved account "${r.name}"${r.email ? ` (${r.email})` : ''}.`);
        return 0;
      }
      case 'use': {
        const r = await m.use(p.name, { reason: 'manual' });
        say(r.switched ? `Switched the Claude login to "${r.to}". Open chats may need "continue" or a reload.` : `"${r.to}" is already the live login.`);
        return 0;
      }
      case 'remove':
        await m.remove(p.name);
        say(`Removed account "${p.name}".`);
        return 0;
      case 'refresh': {
        if (p.name) { await m.refresh(p.name); say(`Refreshed "${p.name}".`); return 0; }
        const res = await m.refreshDue();
        if (!res.length) say('No saved login needs a refresh.');
        for (const r of res) (r.ok ? say : warn)(r.ok ? `Refreshed "${r.name}".` : `${r.name ?? 'accounts'}: ${r.error}`);
        return res.every((r) => r.ok) ? 0 : 1;
      }
      default:
        warn(USAGE);
        return 2;
    }
  } catch (e) {
    warn(`accounts ${p.cmd}: ${e.message}`);
    return 1;
  }
}
