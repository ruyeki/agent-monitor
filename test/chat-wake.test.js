// The chat wake helper: registry lookup, dedupe, fallback reasons, loop guard, helper argv, concurrency, close.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createChatWake } from '../src/chat-wake.js';

const SID = '11111111-1111-4111-8111-111111111111';
const SID2 = '22222222-2222-4222-8222-222222222222';
const HELPER = '99999999-9999-4999-8999-999999999999';
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'am-cw-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(5); } return false; };

// Registry on disk, with a .key canary that must never be opened.
function world(entries = [{ pid: 101, sessionId: SID, name: 'Nike Board', status: 'idle', statusUpdatedAt: 1000 }]) {
  const dir = tmp();
  const put = (e) => fs.writeFileSync(path.join(dir, `${e.pid}.json`), JSON.stringify(e));
  entries.forEach(put);
  fs.writeFileSync(path.join(dir, '101.abc.key'), 'SECRET');
  fs.writeFileSync(path.join(dir, 'notes.json'), JSON.stringify({ pid: 5, sessionId: 'x' }));
  return { dir, put, update: (pid, patch) => put({ ...JSON.parse(fs.readFileSync(path.join(dir, `${pid}.json`), 'utf8')), ...patch }) };
}

const toolResult = (success) => ({ type: 'user', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: JSON.stringify({ success, message: 'm' }) }] }] } });
const initEv = (id) => ({ type: 'system', subtype: 'init', session_id: id });
const heldEv = { type: 'system', subtype: 'informational', level: 'warning', content: 'Cross-session message held for approval (recipient: x).' };

// A fake spawn. `script(child, ctx)` decides what the helper prints and when it exits.
function fake(script = (c) => { c.say(initEv(HELPER)); c.say(toolResult(true)); c.exit(0); }) {
  const calls = [];
  const spawn = (command, argv, opts) => {
    const child = new EventEmitter();
    child.pid = 5000 + calls.length;
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let stdin = '';
    child.stdin = new PassThrough();
    child.stdin.on('data', (d) => { stdin += d; });
    const write = (ev) => child.stdout.write(`${JSON.stringify(ev)}\n`);
    // A successful tool_result is preceded by the helper's tool_use, copied from the prompt (set child.noUse to skip it).
    child.say = (ev) => {
      const ok = ev.type === 'user' && JSON.stringify(ev).includes('success\\":true');
      if (ok && !child.noUse) write({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'SendMessage', input: JSON.parse(stdin.split('\n')[1]) }] } });
      write(ev);
    };
    child.exit = (code) => { child.stdout.end(); setImmediate(() => child.emit('close', code)); };
    const call = { command, argv, opts, child, stdin: () => stdin, at: Date.now() };
    calls.push(call);
    setImmediate(() => script(child, call));
    return child;
  };
  return { spawn, calls };
}

function make(w, f, extra = {}) {
  const kills = [];
  const opts = {
    sessionsDir: w.dir, command: 'claude.exe', spawn: f.spawn, killTree: (pid) => kills.push(pid), env: { PATH: 'x' },
    modeOf: () => 'bypassPermissions', isAlive: () => true, pollMs: 5, idleWaitMs: 60, confirmWaitMs: 60, helperTimeoutMs: 500, ...extra,
  };
  const cw = createChatWake(opts);
  return { cw, kills, opts };
}

// A delivered send flips the registry entry to busy after the helper's tool_result.
const deliver = (w, pid = 101) => (c) => { w.update(pid, { status: 'busy', statusUpdatedAt: Date.now() + 1000 }); c.say(initEv(HELPER)); c.say(toolResult(true)); c.exit(0); };

test('ok: sends the notice, confirms from the registry, exact argv/cwd/env/stdin', async () => {
  const w = world();
  const f = fake(deliver(w));
  const { cw } = make(w, f, { args: ['--pre'], env: { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:/cfg', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', claude_code_entrypoint: 'x', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_PID: '1', CLAUDE_EFFORT: 'h', CLAUDE_AGENT_SDK_VERSION: '1' } });
  const r = await cw.wake(SID, { account: 'orders' });
  assert.deepEqual(r, { ok: true, name: 'Nike Board', reason: undefined, found: true, quiet: false });
  const c = f.calls[0];
  assert.equal(c.command, 'claude.exe');
  assert.deepEqual(c.argv, ['--pre', '-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions', '--tools', 'SendMessage', '--strict-mcp-config', '--max-turns', '3', '--name', 'agent-monitor', '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--system-prompt', 'You deliver one status notice with the SendMessage tool, then stop.']);
  assert.ok(path.basename(c.opts.cwd).startsWith('am-chat-wake-') && path.dirname(c.opts.cwd) === os.tmpdir()); // a private folder, never the shared temp dir itself
  assert.equal(c.opts.shell, false);
  assert.equal(c.opts.windowsHide, true);
  assert.deepEqual(c.opts.stdio, ['pipe', 'pipe', 'pipe']);
  assert.deepEqual(c.opts.env, { PATH: 'p', CLAUDE_CONFIG_DIR: 'C:/cfg', CLAUDE_CODE_GIT_BASH_PATH: 'C:/git/bash.exe', NoDefaultCurrentDirectoryInExePath: '1' });
  const notice = 'Agent Monitor (automatic notice): your last turn stopped at a Claude usage limit. The login was switched to account orders, which has usage left, so the limit no longer applies. This is a status notice, not a request; no reply is needed.';
  assert.equal(c.stdin(), `Call the SendMessage tool exactly once with this input, copied exactly:\n${JSON.stringify({ to: 'Nike Board', message: notice })}\nDo not call any other tool. After it returns, reply with only the tool result text.`);
});

test('the prompt JSON-encodes the name, never pastes it raw', async () => {
  const w = world([{ pid: 101, sessionId: SID, name: 'Nike (v2): a&b #1', status: 'idle', statusUpdatedAt: 1 }]);
  const f = fake(deliver(w));
  const { cw } = make(w, f);
  assert.equal((await cw.wake(SID, { account: 'a' })).ok, true);
  assert.ok(f.calls[0].stdin().includes('"to":"Nike (v2): a&b #1"'));
});

test('mode mapping: bypassPermissions stays, default/acceptEdits/plan become manual, null fails', async () => {
  const seen = {};
  for (const mode of ['bypassPermissions', 'default', 'acceptEdits', 'plan']) {
    const w = world();
    const f = fake(deliver(w));
    const { cw } = make(w, f, { modeOf: () => mode });
    assert.equal((await cw.wake(SID, { account: 'a' })).ok, true);
    const a = f.calls[0].argv;
    seen[mode] = a[a.indexOf('--permission-mode') + 1];
  }
  assert.deepEqual(seen, { bypassPermissions: 'bypassPermissions', default: 'manual', acceptEdits: 'manual', plan: 'manual' });
  for (const unknown of [null, undefined, '', 'dontAsk', 'bogus']) {
    const w = world();
    const f = fake();
    const { cw } = make(w, f, { modeOf: () => unknown });
    assert.deepEqual(await cw.wake(SID, { account: 'a' }), { ok: false, reason: 'mode unknown', name: 'Nike Board', found: true, quiet: false });
    assert.equal(f.calls.length, 0);
  }
});

test('off: no sessionsDir or no command, a bad id and a bad account never spawn', async () => {
  const w = world();
  const f = fake();
  assert.equal((await make(w, f, { sessionsDir: undefined }).cw.wake(SID, { account: 'a' })).reason, 'off');
  assert.equal((await make(w, f, { command: undefined }).cw.wake(SID, { account: 'a' })).reason, 'off');
  const { cw } = make(w, f);
  assert.equal((await cw.wake('chat', { account: 'a' })).reason, 'bad session id');
  assert.equal((await cw.wake(undefined, { account: 'a' })).ok, false);
  assert.equal((await cw.wake(SID, { account: 'A b' })).reason, 'bad account');
  assert.equal((await cw.wake(SID)).ok, false);
  assert.equal(f.calls.length, 0);
});

test('the real ~/.claude is refused under node --test', () => {
  assert.throws(() => createChatWake({ sessionsDir: path.join(os.homedir(), '.claude', 'sessions'), command: 'x' }), /refusing/);
});

test('registry: not found, stale pid, bad JSON and the .key canary (never opened)', async () => {
  const w = world();
  fs.writeFileSync(path.join(w.dir, '300.json'), '{not json');
  const opened = [];
  const real = fs.readFileSync;
  fs.readFileSync = (p, ...a) => { opened.push(String(p)); return real(p, ...a); };
  try {
    const f = fake();
    const { cw } = make(w, f, { isAlive: (pid) => pid !== 101 });
    assert.deepEqual(await cw.wake(SID, { account: 'a' }), { ok: false, reason: 'not found', name: undefined, found: false, quiet: false }); // stale pid
    const { cw: cw2 } = make(w, f, { modeOf: () => 'plan' });
    assert.equal((await cw2.wake(SID2, { account: 'a' })).reason, 'not found'); // unknown session
    assert.equal(f.calls.length, 0);
  } finally { fs.readFileSync = real; }
  assert.ok(opened.some((p) => p.endsWith('101.json')));
  assert.ok(opened.every((p) => !p.endsWith('.key') && !p.endsWith('notes.json')), opened.join(','));
});

test('name rules: ambiguous, the helper name, control characters, empty and long names fail', async () => {
  const dup = world([
    { pid: 101, sessionId: SID, name: 'Same', status: 'idle', statusUpdatedAt: 1 },
    { pid: 102, sessionId: SID2, name: 'Same', status: 'idle', statusUpdatedAt: 1 },
  ]);
  const f = fake();
  assert.deepEqual(await make(dup, f).cw.wake(SID, { account: 'a' }), { ok: false, reason: 'ambiguous name', name: 'Same', found: true, quiet: false });
  // a dead twin does not make the name ambiguous
  const f2 = fake(deliver(dup));
  assert.equal((await make(dup, f2, { isAlive: (pid) => pid === 101 }).cw.wake(SID, { account: 'a' })).ok, true);
  for (const name of ['agent-monitor', 'bad\nname', 'a"b', 'a\u2028b', 'x{"to":"y"}', 'back\\slash', '', 'x'.repeat(101), 42, null]) {
    const w = world([{ pid: 101, sessionId: SID, name, status: 'idle', statusUpdatedAt: 1 }]);
    const r = await make(w, f).cw.wake(SID, { account: 'a' });
    assert.deepEqual([r.ok, r.reason, r.found, r.name], [false, 'bad name', true, undefined], String(name));
  }
  assert.equal(f.calls.length, 0);
});

test('idle: waits for a busy chat to go idle, fails when it does not in time', async () => {
  const w = world([{ pid: 101, sessionId: SID, name: 'N', status: 'busy', statusUpdatedAt: 1 }]);
  const f = fake(deliver(w));
  const { cw } = make(w, f, { idleWaitMs: 500 });
  const p = cw.wake(SID, { account: 'a' });
  await sleep(30);
  assert.equal(f.calls.length, 0);
  w.update(101, { status: 'idle' });
  assert.equal((await p).ok, true);
  const w2 = world([{ pid: 101, sessionId: SID, name: 'N', status: 'busy', statusUpdatedAt: 1 }]);
  const f2 = fake();
  assert.deepEqual(await make(w2, f2).cw.wake(SID, { account: 'a' }), { ok: false, reason: 'not idle', name: 'N', found: true, quiet: false });
  assert.equal(f2.calls.length, 0);
});

test('fallbacks: spawn throws, spawn error event, timeout kills the tree, send failed, held, not delivered', async () => {
  const cases = {
    'spawn error': [{ spawn: () => { throw new Error('ENOENT'); } }, undefined],
    'spawn error ': [fake((c) => c.emit('error', new Error('boom'))), undefined],
    'send failed': [fake((c) => { c.say(initEv(HELPER)); c.say(toolResult(false)); c.exit(0); }), undefined],
    held: [fake((c) => { c.say(toolResult(true)); c.say(heldEv); c.exit(0); }), undefined],
    'not delivered': [fake((c) => { c.say(toolResult(true)); c.exit(0); }), undefined], // success but the registry never changed
    'not delivered ': [fake((c) => { c.exit(1); }), undefined], // no tool_result at all
  };
  for (const [reason, [f]] of Object.entries(cases)) {
    const w = world();
    const r = await make(w, f).cw.wake(SID, { account: 'a' });
    assert.deepEqual([r.ok, r.reason, r.name, r.found], [false, reason.trim(), 'Nike Board', true], reason);
  }
  const w = world();
  const f = fake(() => {}); // never exits
  const { cw, kills } = make(w, f, { helperTimeoutMs: 40 });
  const r = await cw.wake(SID, { account: 'a' });
  assert.deepEqual([r.ok, r.reason, r.found], [false, 'timeout', true]);
  assert.deepEqual(kills, [f.calls[0].child.pid]);
});

test('confirm: a registry entry that is already back to idle with a newer statusUpdatedAt counts', async () => {
  const w = world();
  const f = fake((c) => { w.update(101, { status: 'idle', statusUpdatedAt: Date.now() + 5000 }); c.say(toolResult(true)); c.exit(0); });
  assert.equal((await make(w, f).cw.wake(SID, { account: 'a' })).ok, true);
});

test('dedupe: one wake per session per window, in-flight wakes coalesce, others are independent', async () => {
  const w = world([
    { pid: 101, sessionId: SID, name: 'One', status: 'idle', statusUpdatedAt: 1 },
    { pid: 102, sessionId: SID2, name: 'Two', status: 'idle', statusUpdatedAt: 1 },
  ]);
  let now = 10_000;
  const f = fake((c) => { setTimeout(deliver(w, 101), 20, c); });
  const { cw } = make(w, f, { clock: () => now, dedupeMs: 1000 });
  const a = cw.wake(SID, { account: 'a' });
  const b = cw.wake(SID, { account: 'a' });
  const [ra, rb] = [await a, await b];
  assert.equal(ra.ok, true);
  assert.equal(ra.quiet, false);
  assert.deepEqual(rb, { ...ra, quiet: true }); // the joiner shares the result but must not notify again
  assert.equal(f.calls.length, 1);
  assert.deepEqual(await cw.wake(SID, { account: 'a' }), { ok: false, reason: 'woken recently', name: 'One', found: true, quiet: false });
  assert.equal((await cw.wake(SID, { account: 'a' })).quiet, true); // only the first repeat in the window may notify
  assert.equal(f.calls.length, 1);
  now += 1001; // window over
  w.update(101, { status: 'idle', statusUpdatedAt: 1 });
  f.calls.length = 0;
  assert.equal((await cw.wake(SID, { account: 'a' })).ok, true);
  assert.equal(f.calls.length, 1);
});

test('dedupe is per limit: the same chat woken onto a different account goes ahead', async () => {
  const w = world();
  let now = 10_000;
  const f = fake((c) => { setTimeout(deliver(w, 101), 20, c); });
  const { cw } = make(w, f, { clock: () => now, dedupeMs: 1000 });
  assert.equal((await cw.wake(SID, { account: 'a' })).ok, true);
  assert.deepEqual(await cw.wake(SID, { account: 'a' }), { ok: false, reason: 'woken recently', name: 'Nike Board', found: true, quiet: false });
  w.update(101, { status: 'idle', statusUpdatedAt: 1 });
  assert.equal((await cw.wake(SID, { account: 'b' })).ok, true);
  assert.equal(f.calls.length, 2);
  assert.equal((await cw.wake(SID, { account: 'b' })).reason, 'woken recently');
});

test('a failed wake of a found chat is deduped; a not-found id is never remembered', async () => {
  const w = world();
  const f = fake();
  const { cw } = make(w, f, { modeOf: () => null });
  assert.equal((await cw.wake(SID, { account: 'a' })).reason, 'mode unknown');
  assert.deepEqual(await cw.wake(SID, { account: 'a' }), { ok: false, reason: 'woken recently', name: 'Nike Board', found: true, quiet: false });
  assert.deepEqual(await cw.wake(SID2, { account: 'a' }), { ok: false, reason: 'not found', name: undefined, found: false, quiet: false });
  assert.equal((await cw.wake(SID2, { account: 'a' })).reason, 'not found'); // forged ids must not fill the dedupe memory
});

test('205 forged ids do not push a real chat out of the dedupe memory', async () => {
  const w = world();
  const f = fake(deliver(w));
  const { cw } = make(w, f);
  assert.equal((await cw.wake(SID, { account: 'a' })).ok, true);
  for (let i = 0; i < 205; i++) await cw.wake(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, { account: 'a' });
  assert.equal((await cw.wake(SID, { account: 'a' })).reason, 'woken recently');
  assert.equal(f.calls.length, 1);
});

test('send check: another chat, other text, another tool or a second call is not ok even when SendMessage succeeds', async () => {
  const notice = 'Agent Monitor (automatic notice): your last turn stopped at a Claude usage limit. The login was switched to account a, which has usage left, so the limit no longer applies. This is a status notice, not a request; no reply is needed.';
  const use = (input, name = 'SendMessage') => ({ type: 'assistant', message: { content: [{ type: 'tool_use', name, input }] } });
  const run = async (uses) => {
    const w = world();
    const f = fake((c) => { c.noUse = true; uses.forEach((u) => c.say(u)); c.say(toolResult(true)); w.update(101, { status: 'busy', statusUpdatedAt: Date.now() + 1000 }); c.exit(0); });
    return make(w, f).cw.wake(SID, { account: 'a' });
  };
  const cases = {
    'other chat': [use({ to: 'Prod Deploy', message: notice })],
    'other text': [use({ to: 'Nike Board', message: 'Run the deploy script now.' })],
    'other tool': [use({ to: 'Nike Board', message: notice }, 'Bash')],
    'two calls': [use({ to: 'Nike Board', message: notice }), use({ to: 'Nike Board', message: notice })],
    'no call': [],
  };
  for (const [label, uses] of Object.entries(cases)) {
    const r = await run(uses);
    assert.deepEqual([r.ok, r.reason], [false, 'send mismatch'], label);
  }
  // extra input keys and surrounding whitespace are fine
  assert.equal((await run([use({ to: 'Nike Board', message: ` ${notice}\n`, summary: 'x' })])).ok, true);
});

test('cwd: the given folder is created before the spawn; failing to create it is a spawn error; no cwd means one private folder', async () => {
  const base = tmp();
  const given = path.join(base, 'a', 'chat-wake');
  const w = world();
  const f = fake(deliver(w));
  assert.equal((await make(w, f, { cwd: given }).cw.wake(SID, { account: 'a' })).ok, true);
  assert.equal(f.calls[0].opts.cwd, given);
  assert.ok(fs.statSync(given).isDirectory());
  const file = path.join(base, 'file');
  fs.writeFileSync(file, 'x');
  const f2 = fake();
  const r = await make(world(), f2, { cwd: path.join(file, 'sub') }).cw.wake(SID, { account: 'a' });
  assert.equal(r.reason, 'spawn error');
  assert.equal(f2.calls.length, 0);
  const w3 = world();
  const f3 = fake(deliver(w3));
  const { cw } = make(w3, f3);
  await cw.wake(SID, { account: 'a' });
  w3.update(101, { status: 'idle', statusUpdatedAt: 1 });
  await cw.wake(SID, { account: 'b' });
  assert.equal(f3.calls[0].opts.cwd, f3.calls[1].opts.cwd);
  assert.notEqual(path.resolve(f3.calls[0].opts.cwd), path.resolve(os.tmpdir()));
});

test('loop guard: the init event marks the helper session; a wake for it is refused', async () => {
  const w = world();
  const f = fake((c) => { c.say(initEv(HELPER)); setTimeout(() => { w.update(101, { status: 'busy', statusUpdatedAt: Date.now() + 1000 }); c.say(toolResult(true)); c.exit(0); }, 20); });
  const { cw } = make(w, f);
  const p = cw.wake(SID, { account: 'a' });
  assert.equal(cw.isHelper(HELPER), false);
  await until(() => cw.isHelper(HELPER));
  assert.equal(cw.isHelper(HELPER), true);
  assert.equal(cw.isHelper(SID), false);
  await p;
  assert.equal((await cw.wake(HELPER, { account: 'a' })).reason, 'helper session');
  assert.equal(f.calls.length, 1);
});

test('the helper id set is bounded to the last 50', async () => {
  const ids = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const w = world();
  const f = fake((c) => { ids.forEach((id) => c.say(initEv(id))); c.say(toolResult(true)); c.exit(0); });
  const { cw } = make(w, f);
  await cw.wake(SID, { account: 'a' });
  assert.equal(cw.isHelper(ids[0]), false);
  assert.equal(cw.isHelper(ids[9]), false);
  assert.equal(cw.isHelper(ids[10]), true);
  assert.equal(cw.isHelper(ids[59]), true);
});

test('concurrency: at most maxConcurrent helpers, the rest queue, overflow fails busy at once', async () => {
  const ids = Array.from({ length: 5 }, (_, i) => `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`);
  const w = world(ids.map((sessionId, i) => ({ pid: 200 + i, sessionId, name: `Chat ${i}`, status: 'idle', statusUpdatedAt: 1 })));
  const open = [];
  const f = fake((c, call) => { open.push({ c, pid: 200 + f.calls.indexOf(call) }); });
  const { cw } = make(w, f, { maxConcurrent: 2, maxQueue: 2 });
  const ps = ids.slice(0, 4).map((id) => cw.wake(id, { account: 'a' }));
  await until(() => f.calls.length === 2);
  await sleep(40);
  assert.equal(f.calls.length, 2); // two queued
  const over = await cw.wake(ids[4], { account: 'a' });
  assert.deepEqual([over.ok, over.reason, over.found], [false, 'busy', true]);
  // finish the first helper: a queued one starts
  const finishOne = (o) => { w.update(o.pid, { status: 'busy', statusUpdatedAt: Date.now() + 1000 }); o.c.say(toolResult(true)); o.c.exit(0); };
  finishOne(open.shift());
  await until(() => f.calls.length === 3);
  assert.equal(f.calls.length, 3);
  for (let finished = 1; finished < 4;) { if (open.length) { finishOne(open.shift()); finished++; } else await sleep(5); }
  const rs = await Promise.all(ps);
  assert.deepEqual(rs.map((r) => r.reason ?? 'ok'), ['ok', 'ok', 'ok', 'ok']);
});

test('close kills running helpers, drops queued wakes, and later wakes are off', async () => {
  const ids = [SID, SID2, '44444444-4444-4444-8444-444444444444'];
  const w = world(ids.map((sessionId, i) => ({ pid: 300 + i, sessionId, name: `C${i}`, status: 'idle', statusUpdatedAt: 1 })));
  const f = fake(() => {});
  const { cw, kills } = make(w, f, { maxConcurrent: 2, helperTimeoutMs: 5000 });
  const ps = ids.map((id) => cw.wake(id, { account: 'a' }));
  await until(() => f.calls.length === 2);
  await sleep(20);
  cw.close();
  const rs = await Promise.all(ps);
  assert.deepEqual(rs.map((r) => r.ok), [false, false, false]);
  assert.deepEqual(kills.sort(), f.calls.map((c) => c.child.pid).sort());
  assert.equal(f.calls.length, 2);
  assert.equal((await cw.wake(SID, { account: 'a' })).reason, 'off');
});

test('wake never rejects, even when the registry folder is gone or modeOf throws', async () => {
  const gone = createChatWake({ sessionsDir: path.join(tmp(), 'nope'), command: 'c', spawn: fake().spawn, modeOf: () => 'plan' });
  assert.equal((await gone.wake(SID, { account: 'a' })).reason, 'not found');
  const w = world();
  const { cw } = make(w, fake(), { modeOf: () => { throw new Error('x'); } });
  assert.equal((await cw.wake(SID, { account: 'a' })).ok, false);
});
