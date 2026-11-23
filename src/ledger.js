// The Ledger's pure core (C8): which tool calls are worth recording, secret masking, and
// turning recorded calls into "what this run changed" items. No I/O, no dependencies.

export const SHELL_TOOLS = /^(bash|powershell|pwsh|shell|exec_command|local_shell|run_shell_command)$/i;
const MAX_TEXT = 20000;
const QUICK = /git|gh\b|pg_dump|sqlite3|\.db|\bcp\b|copy|cpi\b|alembic|flask|migrat|upgrade|pm2|systemctl|service|docker|nssm|kill|Stop-Process|screen|restart|worktree|ssh|\bdb\b/i;
const ERR = /(^|\n)\s*(fatal:|error:)|! \[(remote )?rejected\]|\[remote rejected\]/i;

// ---------- input normalising ----------

function shellText(input) {
  if (input == null) return '';
  if (Array.isArray(input)) {
    if (/^(bash|sh|zsh|pwsh|powershell)(\.exe)?$/i.test(String(input[0])) && /^-(l?c|command)$/i.test(String(input[1]))) {
      return input.slice(2).join(' ');
    }
    return input.map((x) => (/\s/.test(String(x)) ? `"${x}"` : String(x))).join(' ');
  }
  if (typeof input === 'object') return shellText(input.command ?? input.cmd ?? input.script ?? '');
  const s = String(input);
  if (s.startsWith('{"command"') || s.startsWith('{"cmd"')) {
    try {
      const o = JSON.parse(s);
      if (o && typeof o === 'object') return shellText(o);
    } catch { /* truncated JSON: use the raw text */ }
  }
  return s;
}

export const isHephaestusUpdate = (tool) => /hephaestus/i.test(tool || '') && /(^|__)update_task$/.test(tool || '');

export function hephInfo(input) {
  const text = typeof input === 'string' ? input : input == null ? '' : JSON.stringify(input);
  const status = /"(?:status|state)"\s*:\s*"([^"]+)/.exec(text);
  const id = /"(?:task_id|taskId|id|number|task)"\s*:\s*"?#?(\d+)/.exec(text);
  return { status: status ? status[1] : null, id: id ? id[1] : null };
}

// ---------- shell scanning ----------

const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time']);
const WRAPPERS = new Set(['sudo', 'nohup', 'env', 'command', 'exec', 'setsid', 'nice', 'doas']);
const SHELLS = /^(ssh|bash|sh|zsh|pwsh|powershell|wsl|cmd|eval|su)$/;

const base = (x) => String(x).replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();

// Drops heredoc bodies that are data (cat/tee, git messages) and keeps ones that run (ssh_run, bash).
// A collapsed one-line summary has no newline after the marker: the body runs to the delimiter word.
function dropData(text) {
  let out = text;
  for (let guard = 0; guard < 20; guard++) {
    const m = /<<-?\s*(['"]?)([A-Za-z_]\w*)\1/.exec(out);
    if (!m) break;
    const head = out.slice(0, m.index);
    const marker = m[0];
    const after = out.slice(m.index + marker.length);
    const nl = after.indexOf('\n');
    let body;
    let rest;
    let headExtra = '';
    if (nl === -1) {
      const end = new RegExp(`\\s${m[2]}(?=[\\s)"']|$)`).exec(after);
      body = end ? after.slice(0, end.index) : after;
      rest = end ? after.slice(end.index + end[0].length) : '';
    } else {
      headExtra = after.slice(0, nl);
      const lines = after.slice(nl + 1).split('\n');
      let i = lines.findIndex((l) => l.trim() === m[2]);
      if (i === -1) i = lines.length;
      body = lines.slice(0, i).join('\n');
      rest = lines.slice(i + 1).join('\n');
    }
    const lineStart = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('&&'), head.lastIndexOf(';'), head.lastIndexOf('|'), head.lastIndexOf('('));
    const isData = /(^|[\s(])(cat|tee)\b[^\n<]*$/.test(head.slice(lineStart + 1));
    out = `${head} ${headExtra}${isData ? '' : `\n${body}\n`}\n${rest}`;
  }
  return out;
}

// PowerShell here-strings are always data; an unclosed one (cut summary) runs to the end.
function dropHereStrings(text) {
  return text.replace(/@'[\s\S]*?'@/g, "''").replace(/@"[\s\S]*?"@/g, '""').replace(/@['"][\s\S]*$/, "''");
}

function scan(text) {
  const stmts = [];
  let words = [];
  let cur = '';
  let has = false;
  let quoted = false;
  const flushWord = () => {
    if (has) words.push({ t: cur, q: quoted });
    cur = '';
    has = false;
    quoted = false;
  };
  const flushStmt = () => {
    flushWord();
    if (words.length) stmts.push(words);
    words = [];
  };
  const n = text.length;
  for (let i = 0; i < n; i++) {
    const c = text[i];
    if (c === "'") {
      has = quoted = true;
      i++;
      while (i < n && text[i] !== "'") cur += text[i++];
    } else if (c === '"') {
      has = quoted = true;
      i++;
      while (i < n && text[i] !== '"') {
        if ((text[i] === '\\' || text[i] === '`') && i + 1 < n && '"\\`$'.includes(text[i + 1])) i++;
        cur += text[i++];
      }
    } else if (c === '\n' || c === ';' || c === '|' || c === '(' || c === ')') {
      if (c === '|' && text[i + 1] === '|') i++;
      flushStmt();
    } else if (c === '&') {
      if (text[i - 1] === '>' || text[i + 1] === '>') { cur += c; has = true; continue; }
      if (text[i + 1] === '&') i++;
      flushStmt();
    } else if (c === ' ' || c === '\t' || c === '\r') {
      flushWord();
    } else if (c === '#' && !has) {
      while (i < n && text[i] !== '\n') i++;
      i--;
    } else {
      cur += c;
      has = true;
    }
  }
  flushStmt();
  return stmts;
}

function stripHead(w) {
  let i = 0;
  while (i < w.length) {
    const x = w[i];
    const b = base(x);
    if (KEYWORDS.has(x) || WRAPPERS.has(b) || /^[A-Za-z_][\w.]*=/.test(x) || /^\$env:[^=]+=/i.test(x)) i++;
    else if ((b === 'uv' || b === 'poetry' || b === 'pipenv') && w[i + 1] === 'run') i += 2;
    else if (/^(python3?|py)$/.test(b) && w[i + 1] === '-m') i += 2;
    else if (/^(python3?|py)$/.test(b) && /\.py$/.test(w[i + 1] || '') && !/ssh_run/.test(w[i + 1])) i++;
    else if (b === 'sshpass') { i++; while (i < w.length && w[i].startsWith('-')) i += /^-[pfdP]$/.test(w[i]) ? 2 : 1; }
    else if (b === 'npx') i++;
    else break;
  }
  return w.slice(i);
}

const nonFlags = (args, valueFlags = []) => {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (valueFlags.includes(a)) { i++; continue; }
    if (a.startsWith('-') && a.length > 1) continue;
    out.push(a);
  }
  return out;
};

const hasFlag = (args, ...names) => args.some((a) => names.includes(a) || names.some((nm) => nm.startsWith('--') && a.startsWith(`${nm}=`)));

function valueOf(args, ...names) {
  for (let i = 0; i < args.length; i++) {
    for (const nm of names) {
      if (args[i] === nm) return args[i + 1];
      if (nm.startsWith('--') && args[i].startsWith(`${nm}=`)) return args[i].slice(nm.length + 1);
    }
  }
  return undefined;
}

const DB_FILE = /\.(db|sqlite3?)$/i;
const AGENT_MONITOR = /agent[-_ ]?monitor|\b4747\b/i;

function gitAction(w) {
  let i = 1;
  while (i < w.length) {
    const a = w[i];
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'].includes(a)) i += 2;
    else if (a.startsWith('-')) i++;
    else break;
  }
  const sub = w[i];
  const args = w.slice(i + 1);
  if (sub === 'commit') return hasFlag(args, '--dry-run') ? null : { kind: 'commit', args };
  if (sub === 'push') {
    if (hasFlag(args, '--dry-run', '-n')) return null;
    const pos = nonFlags(args, ['--repo', '-o', '--push-option', '--receive-pack', '--exec']);
    const force = hasFlag(args, '--force', '-f', '--force-with-lease', '--force-if-includes') || pos.slice(1).some((p) => p.startsWith('+'));
    return { kind: 'push', args, remote: pos[0], refspec: pos[1], force };
  }
  if (sub === 'merge') {
    if (hasFlag(args, '--abort', '--quit')) return null;
    return { kind: 'merge', args, branch: nonFlags(args, ['-m', '-s', '-X', '--into-name'])[0] };
  }
  if (sub === 'worktree' && (args[0] === 'add' || args[0] === 'remove')) {
    const rest = args.slice(1);
    return { kind: args[0] === 'add' ? 'worktree-add' : 'worktree-remove', args: rest, path: nonFlags(rest, ['-b', '-B', '--reason', '--orphan'])[0], branch: valueOf(rest, '-b', '-B') };
  }
  return null;
}

function ghAction(w) {
  let i = 1;
  while (i < w.length && w[i].startsWith('-')) i += w[i] === '-R' || w[i] === '--repo' ? 2 : 1;
  if (w[i] !== 'pr') return null;
  const args = w.slice(i + 2);
  if (w[i + 1] === 'create') return { kind: 'pr-create', args };
  if (w[i + 1] === 'merge') return { kind: 'pr-merge', args };
  return null;
}

function copyAction(w) {
  const args = [];
  for (let i = 1; i < w.length; i++) {
    const a = w[i];
    if (/^-(path|literalpath|destination)$/i.test(a)) { if (w[i + 1]) args.push(w[++i]); continue; }
    if (a.startsWith('-') && a.length > 1) continue;
    args.push(a);
  }
  if (args.length >= 2 && DB_FILE.test(args[0])) return { kind: 'db-backup', file: args[args.length - 1], db: args[0].replace(/^.*[\\/]/, '') };
  return null;
}

const UPGRADE = [
  /^alembic\b.*\b(upgrade|downgrade)\b/,
  /^flask\b.*\bdb\s+(upgrade|downgrade|migrate)\b/,
  /^manage\.py\s+migrate\b/,
  /^(prisma|knex|sequelize|sequelize-cli|typeorm|drizzle-kit)\b.*\bmigrat/,
  /^(npm|pnpm|yarn)\s+(run\s+)?\S*(migrate|db:upgrade|db-upgrade)\S*/,
  /^node\b.*\b(migrate|db\s+upgrade)\b/,
  /^psql\b.*\s-f\s+\S*migrat/,
  /^(\S+\s+)?db\s+upgrade\b/,
];

const KILL = /^(kill|pkill|killall|taskkill|stop-process|fuser)$/i;

function statementAction(words, ctx, depth) {
  const raw = words.map((x) => x.t);
  const w = stripHead(raw);
  if (!w.length) return null;
  const head = base(w[0]);
  const joined = w.map((x, i) => (i === 0 ? head : x)).join(' ');

  if (head === 'git') return gitAction(w);
  if (head === 'gh') return ghAction(w);
  if (head === 'cp' || head === 'copy' || head === 'copy-item' || head === 'cpi') return copyAction(w);
  if (head === 'pg_dump' || head === 'pg_dumpall') {
    const redirect = w.findIndex((x) => x === '>' || x === '>>');
    const file = valueOf(w, '-f', '--file') ?? (redirect >= 0 ? w[redirect + 1] : undefined);
    return { kind: 'db-backup', file, db: valueOf(w, '-d', '--dbname') };
  }
  if (head === 'sqlite3') {
    const idx = w.findIndex((x) => /^\.backup\b|\.backup\s/.test(x) || /\bvacuum\s+into\b/i.test(x));
    if (idx >= 0) {
      const inline = /\.backup\s+(\S+)/.exec(w[idx]) || /vacuum\s+into\s+'?([^'\s;]+)/i.exec(w[idx]);
      const db = w.slice(1).find((x) => DB_FILE.test(x));
      return { kind: 'db-backup', file: inline ? inline[1] : w[idx + 1], db };
    }
    return null;
  }
  if (UPGRADE.some((re) => re.test(joined)) && !hasFlag(w, '--sql', '--dry-run')) {
    return { kind: 'db-upgrade' };
  }

  // restarts
  if (head === 'pm2' && /^(restart|reload|start|startorrestart|startorreload)$/.test(w[1] || '')) return { kind: 'restart', name: nonFlags(w.slice(2))[0], text: joined };
  if (head === 'systemctl') {
    const pos = nonFlags(w.slice(1));
    if (/^(restart|reload|start|try-restart|reload-or-restart)$/.test(pos[0] || '')) return { kind: 'restart', name: pos[1], text: joined };
  }
  if (head === 'service' && /^(restart|reload|start)$/.test(w[2] || '')) return { kind: 'restart', name: w[1], text: joined };
  if (head === 'restart-service' || (head === 'nssm' && w[1] === 'restart')) return { kind: 'restart', name: nonFlags(w.slice(head === 'nssm' ? 2 : 1))[0], text: joined };
  if ((head === 'docker' || head === 'docker-compose') && w.includes('restart')) {
    return { kind: 'restart', name: nonFlags(w.slice(w.indexOf('restart') + 1))[0], text: joined };
  }
  if (head === 'screen' && w.some((x) => /^-dm/.test(x))) return { kind: 'restart', name: undefined, text: joined };

  // containers: look inside `docker exec <c> pg_dump ...`
  if ((head === 'docker' || head === 'kubectl') && w.includes('exec')) {
    const j = w.findIndex((x, k) => k > w.indexOf('exec') && /^(pg_dump|pg_dumpall|sqlite3|alembic|flask|python3?|npm|node|git|gh)$/.test(x));
    if (j > 0) return statementAction(w.slice(j).map((t) => ({ t, q: false })), ctx, depth);
  }

  // shells and ssh: the real command is inside a quoted argument
  if (SHELLS.test(head) && depth < 3) {
    for (const x of words.slice(1)) {
      if (x.q && /\s/.test(x.t)) ctx.inner.push(x.t);
    }
  }
  if (KILL.test(head)) ctx.kill = true;
  if (head === 'start-process' || head === 'nohup' || head === 'setsid' || /^(uvicorn|gunicorn)$/.test(head) || (/^(npm|pnpm|yarn)$/.test(head) && /^(start|run)$/.test(w[1] || '') && /start|serve/.test(w[2] || w[1])) || (head === 'node' && /\b(serve|server)\b/.test(joined))) ctx.start = true;
  if (raw.some((x) => /^nohup$/.test(base(x)))) ctx.start = true;
  return null;
}

function analyze(text, depth = 0) {
  const ctx = { kill: false, start: false, inner: [] };
  const cleaned = dropHereStrings(dropData(text.slice(0, MAX_TEXT).replace(/\\\r?\n/g, ' ')));
  const actions = [];
  for (const words of scan(cleaned)) {
    const a = statementAction(words, ctx, depth);
    if (a) actions.push(a);
  }
  if (depth < 3) for (const inner of ctx.inner) actions.push(...analyze(inner, depth + 1));
  if (ctx.kill && ctx.start && !actions.some((a) => a.kind === 'restart')) {
    actions.push({ kind: 'restart', name: undefined, text: cleaned });
  }
  return actions;
}

function hostOf(text) {
  const m = /ssh_run\.py\s+(\w[\w.-]*)/.exec(text) || /\bssh\s+(?:-\S+\s+)*(?:\w+@)?(\w[\w.-]*)/.exec(text);
  return m ? m[1] : 'this laptop';
}

// ---------- public: candidate check ----------

export function isChangeCandidate(tool, input) {
  if (isHephaestusUpdate(tool)) return Boolean(hephInfo(input).status);
  if (!SHELL_TOOLS.test(tool || '')) return false;
  const text = shellText(input);
  if (!text || !QUICK.test(text)) return false;
  return analyze(text).length > 0;
}

// ---------- public: redaction ----------

const MASK = '***';
const SECRET_NAME = '[A-Za-z0-9_]{0,64}(?:PASSWORD|PASSWD|TOKEN|SECRET|API_?KEY|ACCESS_KEY|PRIVATE_KEY)';
const QUOTED_OR_WORD = String.raw`"[^"]*"|'[^']*'|[^\s"';&|)]+`;

const keepRef = (value) => /^["']?[$%]/.test(value) || value.includes(MASK);

// Every pattern here must stay linear: bounded repeats, nothing that rescans from each letter of a long run.
// Command families whose own flags carry a password (mysql -pSECRET): masked only inside that one command.
const maskIn = (s, head, inner) => s.replace(head, (seg) => inner(seg));
const MYSQL = /\b(?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n;&|]{0,400}/gi;
const DOCKER_LOGIN = /\b(?:docker|podman|nerdctl)\s+login\b[^\n;&|]{0,400}/gi;
const SSHPASS = /\bsshpass\b[^\n;&|]{0,200}/gi;

export function redact(text) {
  if (text == null) return '';
  let s = String(text);
  s = s.replace(/\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s:/@"']{1,256}):([^\s@/"']{1,512})@/gi, `$1:${MASK}@`);
  s = s.replace(/(authorization[ \t]{0,5}:[ \t]{0,5}(?:bearer|basic|token)?[ \t]{0,5})[^\s"'`]+/gi, (m, p) => (m.includes(MASK) ? m : `${p}${MASK}`));
  s = s.replace(/\bBearer[ \t]{1,5}[A-Za-z0-9._~+/=-]{16,}/g, `Bearer ${MASK}`);
  s = s.replace(/(\b[\w-]{0,40}(?:api-?key|-token|-secret|-password)[ \t]{0,5}:[ \t]{0,5})("[^"]*"|'[^']*'|[^\s"'`]+)/gi, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  s = s.replace(/("[\w-]{0,64}(?:password|passwd|token|secret|api[_-]?key)"[ \t]{0,5}:[ \t]{0,5})"[^"]*"/gi, `$1"${MASK}"`);
  s = s.replace(new RegExp(String.raw`(\$env:${SECRET_NAME}[ \t]{0,5}=[ \t]{0,5})("[^"]*"|'[^']*'|[^\s;]+)`, 'gi'), (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  // PowerShell variables named like a secret: $dbPassword = 'x'
  s = s.replace(/(\$[A-Za-z0-9_]{0,64}(?:password|passwd|token|secret|api_?key|credential)[A-Za-z0-9_]{0,32}[ \t]{0,5}=[ \t]{0,5})("[^"]*"|'[^']*'|[^\s;]+)/gi, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  s = s.replace(new RegExp(`\\b(${SECRET_NAME})(=)(${QUOTED_OR_WORD})`, 'gi'), (m, k, eq, v) => (keepRef(v) ? m : `${k}${eq}${MASK}`));
  // connection strings: ...;Pwd=secret;
  s = s.replace(/(?<=[;"'])([ \t]{0,3}pwd=)([^;"'\s]{1,512})/gi, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  s = s.replace(/(--?(?:password|passwd|token|secret|api-?key)(?:=|[ \t]{1,5}))(?!-)("[^"]*"|'[^']*'|[^\s]+)/gi, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  // curl -u user:pw / --user user:pw
  s = s.replace(/((?<![\w-])(?:-u|--user|--proxy-user)(?:=|[ \t]{1,5})["']?[^\s:"']{1,128}:)([^\s"']{1,512})/g, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`));
  s = maskIn(s, SSHPASS, (seg) => seg.replace(/((?<![\w-])-p[ \t]{0,3})("[^"]*"|'[^']*'|[^\s]+)/, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`)));
  s = maskIn(s, MYSQL, (seg) => seg.replace(/((?<![\w-])-p[ \t]{0,3})("[^"]*"|'[^']*'|[^\s-][^\s]*)/g, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`)));
  s = maskIn(s, DOCKER_LOGIN, (seg) => seg.replace(/((?<![\w-])-p[ \t]{1,3})("[^"]*"|'[^']*'|[^\s]+)/g, (m, p, v) => (keepRef(v) ? m : `${p}${MASK}`)));
  s = s.replace(/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|npm_[A-Za-z0-9]{30,}|eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+)/g, MASK);
  return s;
}

// Text for the Ledger: cut before masking (so a huge response never reaches the regexes whole), mask, then cut to max.
export const ledgerText = (v, max) => redact(String(v ?? '').slice(0, max + 512)).slice(0, max);

// A long result keeps its head and its tail (git's `[branch hash] subject` and push lines come last), exactly max long.
export function ledgerResult(v, max) {
  const raw = String(v ?? '');
  const keep = max * 4;
  const cut = raw.length > keep * 2 ? `${raw.slice(0, keep)}\n${raw.slice(-keep)}` : raw;
  const s = redact(cut);
  if (s.length <= max) return s;
  const marker = '\n[...]\n';
  const head = Math.round(max * 0.3);
  return s.slice(0, head) + marker + s.slice(s.length - (max - head - marker.length));
}

// ---------- public: classification ----------

const TAGS = {
  permanent: "Can't undo",
  backup: 'Backup kept',
  reversible: 'Can change back',
};
const tagged = (tag) => ({ tag, tagLabel: TAGS[tag] });
const PUSHED = { tag: 'info', tagLabel: 'Pushed' };

function parseCommit(result, nth) {
  if (!result) return null;
  const all = [...result.matchAll(/^\[(.+?) ([0-9a-f]{7,40})\] (.*)$/gm)];
  const m = all[nth];
  if (!m) return null;
  const rest = result.slice(m.index + m[0].length);
  const next = /^\s*(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/m.exec(rest.slice(0, 600));
  return {
    branch: m[1].replace(/ \(root-commit\)$/, ''),
    hash: m[2].slice(0, 7),
    subject: m[3].trim(),
    stats: next ? { files: +next[1], insertions: +(next[2] || 0), deletions: +(next[3] || 0) } : null,
  };
}

function parsePush(result) {
  if (!result) return {};
  const out = {};
  const to = /^To\s+(\S+)/m.exec(result);
  if (to) out.remote = to[1];
  const ref = /^\s*[ +*=-]?\s*([0-9a-f]{7,40})\.{2,3}([0-9a-f]{7,40})\s+(\S+)\s+->\s+(\S+)/m.exec(result);
  if (ref) Object.assign(out, { from: ref[1].slice(0, 7), to: ref[2].slice(0, 7), branch: ref[4] });
  const nb = /\[new (branch|tag)\]\s+(\S+)\s+->\s+(\S+)/.exec(result);
  if (nb) Object.assign(out, { isNew: true, branch: nb[3] });
  if (/\(forced update\)/.test(result)) out.forced = true;
  out.upToDate = /Everything up-to-date/.test(result) && !ref && !nb;
  return out;
}

function repoOf(remote) {
  if (!remote) return null;
  const m = /[:/]([^/:@]+\/[^/]+?)(?:\.git)?$/.exec(remote);
  return m ? m[1] : null;
}

function destOf(remoteUrl, remoteName) {
  if (remoteUrl) {
    if (/github\.com/i.test(remoteUrl)) return 'GitHub';
    const h = /^(?:\w+:\/\/)?(?:[^@/]+@)?([^/:]+)/.exec(remoteUrl);
    return h ? h[1] : remoteUrl;
  }
  return !remoteName || /^(origin|upstream)$/.test(remoteName) ? 'GitHub' : remoteName;
}

function short(p) {
  return p ? String(p).replace(/^.*[\\/]/, '') : null;
}

function buildItem(a, row, ctx) {
  const result = row.result || '';
  const host = ctx.host;
  const nth = ctx.counts[a.kind] = (ctx.counts[a.kind] || 0);
  ctx.counts[a.kind]++;
  const common = { at: row.at, agentId: row.agentId ?? null, kind: a.kind };
  switch (a.kind) {
    case 'commit': {
      const c = parseCommit(row.result, nth);
      const msg = valueOf(a.args, '-m', '--message');
      const subject = c ? c.subject : msg ? msg.split('\n')[0].trim() : '';
      const chips = [`git${c ? ` · ${c.branch}` : ''}`];
      if (c && c.stats) chips.push(`+${c.stats.insertions}`, `\u2212${c.stats.deletions}`, `${c.stats.files} ${c.stats.files === 1 ? 'file' : 'files'}`);
      return {
        ...common, category: 'code',
        title: c ? `Committed ${c.hash}${subject ? ` ${subject}` : ''}` : subject ? `Committed ${subject}` : 'Committed changes',
        chips, detail: '', stats: c ? c.stats : null, ...tagged('reversible'),
      };
    }
    case 'push': {
      const p = parsePush(row.result);
      if (p.upToDate) return null;
      const spec = a.refspec ? a.refspec.replace(/^\+/, '').split(':').pop() : null;
      const branch = p.branch || spec;
      const forced = a.force || p.forced;
      const dest = destOf(p.remote, a.remote);
      const repo = repoOf(p.remote);
      const chips = [];
      if (repo) chips.push(repo);
      if (p.from) chips.push(`${p.from} \u2192 ${p.to}`);
      const bits = [];
      if (p.isNew) bits.push('New branch on the remote');
      if (forced) bits.push('Force push');
      return {
        ...common, category: 'code',
        title: `${forced ? 'Force-pushed' : 'Pushed'}${branch ? ` ${branch}` : ''} to ${dest}`,
        chips, detail: bits.join(' · '), ...tagged('permanent'),
      };
    }
    case 'merge':
      return { ...common, category: 'code', title: a.branch ? `Merged ${a.branch}` : 'Merged a branch', chips: ['git'], detail: '', ...tagged('reversible') };
    case 'pr-create': {
      const url = /https:\/\/github\.com\/([^\s/]+\/[^\s/]+)\/pull\/(\d+)/.exec(result);
      const title = valueOf(a.args, '--title', '-t');
      return {
        ...common, category: 'code',
        title: url ? `Opened pull request #${url[2]}` : 'Opened a pull request',
        chips: url ? ['gh', url[1]] : ['gh'], detail: title || (url ? url[0] : ''), ...tagged('reversible'),
      };
    }
    case 'pr-merge': {
      const num = /^#?(\d+)$/.exec(nonFlags(a.args, ['--body', '-b', '--subject', '-t', '--repo', '-R'])[0] || '') || /pull request #(\d+)/i.exec(result) || /\/pull\/(\d+)/.exec(result);
      return { ...common, category: 'code', title: num ? `Merged pull request #${num[1]}` : 'Merged a pull request', chips: ['gh'], detail: '', ...tagged('permanent') };
    }
    case 'worktree-add':
      return { ...common, category: 'machines', title: 'Created a worktree', chips: [host, ...(a.path ? [a.path] : [])], detail: a.branch ? `Branch ${a.branch}` : '', ...tagged('reversible') };
    case 'worktree-remove':
      return { ...common, category: 'machines', title: 'Removed a worktree', chips: [host, ...(a.path ? [a.path] : [])], detail: '', tag: 'info', tagLabel: 'Cleaned up' };
    case 'db-backup':
      return { ...common, category: 'machines', title: 'Backed up the database', chips: [host, ...(a.db ? [short(a.db)] : [])], detail: a.file ? `Saved as ${a.file}` : '', file: a.file || null, ...tagged('backup') };
    case 'db-upgrade': {
      const sv = /schema\s+v?(\d+)\s*(?:\u2192|->|to)\s*v?(\d+)/i.exec(result);
      const bk = ctx.lastBackup;
      return {
        ...common, category: 'machines', title: 'Upgraded the database',
        chips: [host, ...(sv ? [`schema v${sv[1]} \u2192 v${sv[2]}`] : [])],
        detail: bk ? `Backup: ${bk.file || bk.detail}` : 'No backup was made first',
        ...tagged(bk ? 'backup' : 'permanent'),
      };
    }
    case 'restart': {
      const name = AGENT_MONITOR.test(a.text || '') || AGENT_MONITOR.test(a.name || '') ? 'the Agent Monitor server' : a.name || 'a server';
      return { ...common, category: 'machines', title: `Restarted ${name}`, chips: [host], detail: '', tag: 'info', tagLabel: 'Ran once' };
    }
    default:
      return null;
  }
}

function failed(a, row) {
  if (row.outcome !== 'error' && !ERR.test(row.result || '')) return false;
  // `commit && push`: the commit stands even when the push failed
  if (a.kind === 'commit' && /^\[.+? [0-9a-f]{7,40}\] /m.test(row.result || '')) return false;
  return true;
}

const byTime = (a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0);

export function classifyChanges(rows) {
  const isRow = (r) => r !== null && typeof r === 'object' && !Array.isArray(r);
  const sorted = (Array.isArray(rows) ? rows : []).filter(isRow).map((r, i) => [r, i]).sort((x, y) => byTime(x[0], y[0]) || x[1] - y[1]).map((x) => x[0]);
  const items = [];
  const unpushed = [];
  let lastBackup = null;

  for (const row of sorted) {
    let actions;
    if (isHephaestusUpdate(row.tool)) {
      if (row.outcome === 'error' || ERR.test(row.result || '')) continue;
      const { status, id } = hephInfo(row.input);
      if (!status) continue;
      items.push({
        id: String(row.id), at: row.at, agentId: row.agentId ?? null, kind: 'task-status', category: 'tasks',
        title: id ? `Set Hephaestus #${id} status` : 'Set a Hephaestus task status',
        chips: ['Hephaestus', status], detail: '', ...tagged('reversible'),
      });
      continue;
    }
    if (!SHELL_TOOLS.test(row.tool || '')) continue;
    const text = shellText(row.input);
    if (!text || !QUICK.test(text)) continue;
    actions = analyze(text);
    if (!actions.length) continue;

    const ctx = { host: hostOf(text), counts: {}, lastBackup };
    const made = [];
    for (const a of actions) {
      if (failed(a, row)) continue;
      ctx.lastBackup = lastBackup;
      const it = buildItem(a, row, ctx);
      if (!it) continue;
      if (a.kind === 'db-backup') lastBackup = it;
      if (a.kind === 'commit') unpushed.push(it);
      if (a.kind === 'push') {
        if (unpushed.length) {
          it.detail = [`Carries ${unpushed.length === 1 ? 'the commit' : `${unpushed.length} commits`} below`, it.detail].filter(Boolean).join(' \u00b7 ');
          for (const c of unpushed) Object.assign(c, PUSHED);
          unpushed.length = 0;
        }
      }
      made.push(it);
    }
    made.forEach((it, i) => {
      it.id = made.length > 1 ? `${row.id}.${i}` : String(row.id);
      items.push(it);
    });
  }

  items.reverse();
  const summary = { commits: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, tasks: 0, restarts: 0, total: items.length, permanent: [] };
  for (const it of items) {
    if (it.kind === 'commit') {
      summary.commits++;
      if (it.stats) {
        summary.files += it.stats.files;
        summary.insertions += it.stats.insertions;
        summary.deletions += it.stats.deletions;
      }
    }
    if (it.kind === 'push') summary.pushes++;
    if (it.kind === 'task-status') summary.tasks++;
    if (it.kind === 'restart') summary.restarts++;
    if (it.tag === 'permanent') summary.permanent.push({ id: it.id, title: it.title, at: it.at });
  }
  return { items, summary };
}
