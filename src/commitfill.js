// Commit fill: when a command's output hid git's `[branch hash] subject` line (`-q`, `| tail -1`, a later checkout),
// read the commits back from git's reflog so the Ledger still shows hash, subject, files and lines.
// One async git call, never through a shell, never awaited by the hook. Every problem answers null.
import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { commitTarget } from './ledger.js';

const HAS_COMMIT_LINE = /^\[.+? [0-9a-f]{7,40}\] /m;
const SLACK_S = 2; // clock slack between the hook and git, in seconds
const POST_ONLY_MS = 10 * 60 * 1000;
const FORMAT = '--format=%x1e%gd%x1f%gs%x1f%H%x1f%D%x1f%s';

// The directory to read, or null. Relative paths resolve against the hook's cwd; `/c/x` becomes `C:/x` on Windows.
export function resolveDir(dir, cwd) {
  let d = dir ?? cwd;
  if (typeof d !== 'string' || !d || /[$%]/.test(d)) return null;
  if (d === '~' || /^~[/\\]/.test(d)) d = path.join(os.homedir(), d.slice(1));
  if (process.platform === 'win32') d = d.replace(/^\/([A-Za-z])(?=\/|$)/, (m, l) => `${l.toUpperCase()}:`);
  if (!path.isAbsolute(d)) {
    if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
    d = path.resolve(cwd, d);
  }
  return d;
}

// Decides if this command needs a fill: { dir, count } or null.
export function planFill(command, cwd, result) {
  const t = commitTarget(command);
  if (!t.local || HAS_COMMIT_LINE.test(String(result ?? '').slice(0, 200000))) return null;
  const dir = resolveDir(t.dir, cwd);
  return dir ? { dir, count: t.count } : null;
}

// Reflog entries (newest first) -> the commit block, oldest first, or null when it is not exactly `count` commits.
export function commitBlock(out, count, sinceSec) {
  const entries = String(out).split('\x1e').slice(1).map((chunk) => {
    const [head, ...rest] = chunk.split('\n');
    const [gd, gs, hash, deco, ...subj] = head.split('\x1f');
    const time = /@\{(\d+)\}/.exec(gd || '');
    const stat = /^\s*(\d+ files? changed.*)$/m.exec(rest.join('\n'));
    return { time: time ? +time[1] : 0, gs: gs || '', hash: hash || '', deco: deco || '', subject: subj.join('\x1f'), stat: stat ? stat[1].trim() : '' };
  });
  if (!entries.length) return null;
  let branch = /HEAD -> ([^,]+)/.exec(entries[0].deco)?.[1] ?? 'HEAD';
  const found = [];
  for (const e of entries) {
    if (/^commit/.test(e.gs) && e.time >= sinceSec - SLACK_S) found.push({ ...e, branch });
    const mv = /^checkout: moving from (\S+) to /.exec(e.gs);
    if (mv) branch = mv[1]; // older entries were on the branch it moved from
  }
  if (found.length !== count) return null;
  return found.reverse().map((e) => `[${e.branch} ${e.hash.slice(0, 7)}] ${e.subject.slice(0, 200)}\n${e.stat ? ` ${e.stat}\n` : ''}`).join('');
}

// Runs the one git call. Resolves the text to append, or null.
export function readCommits(plan, sinceMs) {
  return new Promise((resolve) => {
    try {
      // The repo is untrusted: no signature check (gpg.program), no network (lazy fetch / ssh / credential helper), no fsmonitor.
      const args = ['-C', plan.dir, '-c', 'protocol.allow=never', '-c', 'core.fsmonitor=false', 'log', '-g', '-n', '20', '--date=unix', '--no-show-signature', '--no-textconv', '--no-ext-diff', '--shortstat', FORMAT, 'HEAD'];
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_NO_LAZY_FETCH: '1' };
      execFile('git', args, { timeout: 3000, maxBuffer: 256 * 1024, windowsHide: true, env }, (err, stdout) => {
        try {
          const block = err ? null : commitBlock(stdout, plan.count, Math.floor(sinceMs / 1000));
          resolve(block ? `\n(commit details read from git)\n${block}` : null);
        } catch { resolve(null); }
      });
    } catch { resolve(null); }
  });
}

export const postOnlyStart = (nowMs) => nowMs - POST_ONLY_MS;
