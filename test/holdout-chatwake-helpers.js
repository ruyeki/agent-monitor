// Shared by the chat-wake verifier tests. Not a test file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { syncBuiltinESMExports } from 'node:module';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const tmpDir = (p = 'am-cw-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
export async function until(fn, ms = 6000, step = 10) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}

export const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const HELPER_ID = uuid(900);
export const NOTICE = (account) => `Agent Monitor (automatic notice): your last turn stopped at a Claude usage limit. The login was switched to account ${account}, which has usage left, so the limit no longer applies. This is a status notice, not a request; no reply is needed.`;

// ---- registry (the fake ~/.claude/sessions) ----
export function makeRegistry() {
  const dir = tmpDir('am-sessions-');
  const alive = new Set();
  const write = (e) => {
    const entry = { kind: 'interactive', entrypoint: 'claude-vscode', cwd: 'C:\\SECRET-CWD-MARKER', status: 'idle', statusUpdatedAt: Date.now() - 60_000, ...e };
    fs.writeFileSync(path.join(dir, `${entry.pid}.json`), JSON.stringify(entry));
    fs.writeFileSync(path.join(dir, `${entry.pid}.canary.key`), 'SECRET-KEY-MARKER');
    if (e.dead !== true) alive.add(entry.pid);
    return entry;
  };
  const patch = (pid, extra) => {
    const f = path.join(dir, `${pid}.json`);
    fs.writeFileSync(f, JSON.stringify({ ...JSON.parse(fs.readFileSync(f, 'utf8')), ...extra }));
  };
  return { dir, alive, write, patch, isAlive: (pid) => alive.has(pid) };
}

// ---- fake claude spawn ----
export function makeSpawn(behave) {
  const calls = [];
  const spawn = (command, args, opts) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.pid = 40_000 + calls.length;
    let input = '';
    const call = { command, args, opts, child, spawnedAt: Date.now(), stdinEnded: false, killed: false };
    Object.defineProperty(call, 'stdin', { get: () => input });
    child.stdin = new Writable({ write(c, _e, cb) { input += c; cb(); }, final(cb) { call.stdinEnded = true; cb(); } });
    child.stdin.on('error', () => {});
    child.kill = () => { call.killed = true; return true; };
    calls.push(call);
    child.stdin.on('finish', () => setImmediate(() => behave?.(call)));
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

export const emit = (call, ev) => call.child.stdout.write(`${JSON.stringify(ev)}\n`);
export const finish = (call, code = 0) => { call.child.stdout.end(); call.child.emit('exit', code, null); call.child.emit('close', code, null); };
export const initEv = (id = HELPER_ID) => ({ type: 'system', subtype: 'init', session_id: id, tools: ['SendMessage'], permissionMode: 'bypassPermissions' });
// The fake helper copies to/message from the prompt on stdin, like the real model is told to.
export const promptInput = (call) => {
  const m = /^\{"to":.*\}$/m.exec(call.stdin);
  try { return m ? JSON.parse(m[0]) : { to: 'x', message: 'y' }; } catch { return { to: 'x', message: 'y' }; }
};
export const toolUse = (id = 'toolu_1', input = { to: 'x', message: 'y' }) => ({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'SendMessage', input }] } });
export const toolResult = (success, id = 'toolu_1') => ({
  type: 'user', message: { role: 'user', content: [{ tool_use_id: id, type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success, message: success ? 'queued there' : "No agent named 'x' is reachable.", ...(success ? { msg_id: 'm1' } : {}) }) }] }] },
});
export const resultEv = { type: 'result', subtype: 'success', is_error: false, num_turns: 2 };
export const heldEv = { type: 'system', subtype: 'informational', level: 'warning', content: 'Cross-session message held for approval (recipient: uds:\\\\.\\pipe\\LOCAL\\cc-msg-1). The recipient\'s session has different permission-mode settings, so their user must approve it before Claude sees it.' };

// A helper that delivers: marks the target busy (touch) like the real recipient, then exits 0.
export function delivering(reg, { touch = true, status = 'busy', success = true, held = false, helperId = HELPER_ID, extra } = {}) {
  return (call) => {
    emit(call, initEv(helperId));
    emit(call, toolUse('toolu_1', promptInput(call)));
    const m = /^\{"to":.*\}$/m.exec(call.stdin);
    const pid = m ? findPidByName(reg, JSON.parse(m[0]).to) : 0;
    if (touch && pid) reg.patch(pid, { status, statusUpdatedAt: Date.now() + 50 });
    emit(call, toolResult(success));
    if (held) emit(call, heldEv);
    extra?.(call);
    emit(call, resultEv);
    finish(call, 0);
  };
}
function findPidByName(reg, name) {
  for (const f of fs.readdirSync(reg.dir)) {
    if (!/^\d+\.json$/.test(f)) continue;
    const e = JSON.parse(fs.readFileSync(path.join(reg.dir, f), 'utf8'));
    if (e.name === name && e.sessionId !== HELPER_ID) return e.pid;
  }
  return 0;
}

export const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

// ---- spy: which files under `dir` does the code under test touch? ----
export function spyFs(dir) {
  const touched = [];
  const orig = {};
  const wrap = (obj, name, label) => {
    const f = obj[name];
    if (typeof f !== 'function') return;
    orig[label] = [obj, name, f];
    obj[name] = function (p, ...rest) {
      try { if (typeof p === 'string' && p.startsWith(dir)) touched.push(p); } catch { /* ignore */ }
      return f.call(this, p, ...rest);
    };
  };
  for (const n of ['readFileSync', 'openSync', 'statSync', 'lstatSync', 'readFile', 'open', 'stat', 'lstat', 'createReadStream', 'accessSync', 'existsSync']) wrap(fs, n, `fs.${n}`);
  for (const n of ['readFile', 'open', 'stat', 'lstat']) wrap(fs.promises, n, `fsp.${n}`);
  syncBuiltinESMExports();
  return {
    touched,
    stop() { for (const [obj, name, f] of Object.values(orig)) obj[name] = f; syncBuiltinESMExports(); },
  };
}
