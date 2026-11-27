// Verifier holdouts for src/chat-wake.js (interface fixed by the fact sheet). Fake spawn, temp registry only.
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { createChatWake } from '../src/chat-wake.js';
import {
  makeRegistry, makeSpawn, delivering, emit, finish, initEv, toolUse, promptInput, toolResult, resultEv, heldEv, argAfter, spyFs,
  uuid, HELPER_ID, NOTICE, sleep, until,
} from './holdout-chatwake-helpers.js';

const T1 = uuid(1);
const ENTRY = { pid: 41001, sessionId: T1, name: 'Nike Board' };

function mk(t, { behave, opts = {}, entries = [ENTRY], modes = { [T1]: 'bypassPermissions' }, env } = {}) {
  const reg = makeRegistry();
  for (const e of entries) reg.write(e);
  const spawn = makeSpawn(behave ? behave(reg) : delivering(reg));
  const kills = [];
  const cw = createChatWake({
    sessionsDir: reg.dir, command: 'C:\\fake\\claude.exe', args: ['--pre'], spawn, killTree: (pid) => kills.push(pid),
    env: env ?? { PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg' }, modeOf: (sid) => modes[sid] ?? null, isAlive: reg.isAlive,
    pollMs: 10, idleWaitMs: 200, confirmWaitMs: 200, helperTimeoutMs: 3000, dedupeMs: 60_000, ...opts,
  });
  t.after(() => cw.close());
  return { reg, spawn, kills, wake: (...a) => cw.wake(...a), isHelper: (...a) => cw.isHelper(...a), close: () => cw.close(), calls: spawn.calls };
}

test('off: no sessionsDir or no command resolves {ok:false, reason:off} and never spawns', async () => {
  const spawn = makeSpawn();
  const a = createChatWake({ command: 'x', spawn });
  const b = createChatWake({ sessionsDir: makeRegistry().dir, spawn });
  const ra = await a.wake(T1, { account: 'b' });
  assert.deepEqual([ra.ok, ra.reason], [false, 'off']);
  assert.equal((await b.wake(T1, { account: 'b' })).reason, 'off');
  assert.equal(spawn.calls.length, 0);
  a.close(); b.close();
});

test('a malformed session id is refused without touching the registry or spawning', async (t) => {
  const w = mk(t);
  const spy = spyFs(w.reg.dir);
  const out = [];
  for (const id of ['', 'nope', '../../etc/passwd', `${T1}/../x`, `${T1} `, undefined, null, 5, {}]) out.push(await w.wake(id, { account: 'b' }));
  spy.stop();
  for (const r of out) { assert.equal(r.ok, false); assert.ok(!r.found); }
  assert.equal(w.calls.length, 0);
});

test('happy path: bypass chat is woken with exactly the feasibility command line', async (t) => {
  const w = mk(t);
  const r = await w.wake(T1, { account: 'b' });
  assert.equal(r.ok, true);
  assert.equal(r.name, 'Nike Board');
  assert.equal(w.calls.length, 1);
  const c = w.calls[0];
  assert.equal(c.command, 'C:\\fake\\claude.exe');
  assert.deepEqual(c.args, [
    '--pre', '-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'bypassPermissions',
    '--tools', 'SendMessage', '--strict-mcp-config', '--max-turns', '3', '--name', 'agent-monitor',
    '--settings', '{"disableAllHooks":true}', '--no-session-persistence',
    '--system-prompt', 'You deliver one status notice with the SendMessage tool, then stop.',
  ]);
  assert.notEqual(path.resolve(c.opts.cwd), path.resolve(os.tmpdir()), 'never the shared temp folder itself');
  assert.equal(path.resolve(path.dirname(c.opts.cwd)), path.resolve(os.tmpdir()), 'a private folder made inside it');
  assert.ok(!c.opts.shell, 'no shell');
  assert.equal(c.opts.windowsHide, true);
  assert.ok(c.stdinEnded, 'stdin is closed after the prompt');
  assert.ok(c.stdin.startsWith('Call the SendMessage tool exactly once with this input, copied exactly:'));
  assert.ok(c.stdin.includes(JSON.stringify({ to: 'Nike Board', message: NOTICE('b') })));
  assert.ok(c.stdin.includes('Do not call any other tool.'));
});

test('a chat name with quotes, backslash or braces is refused as "bad name" with no spawn', async (t) => {
  const name = 'My "chat" \ {x} ]';
  const w = mk(t, { entries: [{ ...ENTRY, name }] });
  const r = await w.wake(T1, { account: 'acct-2' });
  assert.deepEqual([r.ok, r.reason, w.calls.length], [false, 'bad name', 0]);
});

test('the chat name is JSON-encoded in the prompt, never pasted raw', async (t) => {
  const name = "Nike (Board): a&b + c/d #1!";
  const w = mk(t, { entries: [{ ...ENTRY, name }] });
  const r = await w.wake(T1, { account: 'acct-2' });
  assert.equal(r.ok, true);
  assert.ok(w.calls[0].stdin.includes(JSON.stringify({ to: name, message: NOTICE('acct-2') })));
});

test('permission mode mapping: bypass stays bypass; default/acceptEdits/plan become manual; unknown fails with no spawn', async (t) => {
  for (const [mode, want] of [['bypassPermissions', 'bypassPermissions'], ['default', 'manual'], ['acceptEdits', 'manual'], ['plan', 'manual']]) {
    const w = mk(t, { modes: { [T1]: mode } });
    const r = await w.wake(T1, { account: 'b' });
    assert.equal(r.ok, true, mode);
    assert.equal(argAfter(w.calls[0].args, '--permission-mode'), want, mode);
  }
  for (const mode of [undefined, null]) {
    const w = mk(t, { modes: { [T1]: mode } });
    const r = await w.wake(T1, { account: 'b' });
    assert.deepEqual([r.ok, r.reason, r.found, r.name], [false, 'mode unknown', true, 'Nike Board'], String(mode));
    assert.equal(w.calls.length, 0);
  }
});

test('a permission mode outside the known four fails as mode unknown (never guessed as manual)', async (t) => {
  const w = mk(t, { modes: { [T1]: 'weird' } });
  const r = await w.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.reason], [false, 'mode unknown']);
  assert.equal(w.calls.length, 0);
});

test('registry lookup: unknown id, dead pid, bad JSON and look-alike files', async (t) => {
  const w = mk(t, { entries: [ENTRY, { pid: 41002, sessionId: uuid(2), name: 'Gone', dead: true }] });
  fs.writeFileSync(path.join(w.reg.dir, '41003.json'), '{not json');
  fs.writeFileSync(path.join(w.reg.dir, 'notapid.json'), JSON.stringify({ pid: 41004, sessionId: uuid(4), name: 'Fake', status: 'idle' }));
  fs.writeFileSync(path.join(w.reg.dir, '41005.json.bak'), JSON.stringify({ pid: 41005, sessionId: uuid(5), name: 'Bak', status: 'idle' }));
  w.reg.alive.add(41004); w.reg.alive.add(41005);
  const r1 = await w.wake(uuid(77), { account: 'b' });
  assert.deepEqual([r1.ok, r1.found], [false, false]);
  assert.equal((await w.wake(uuid(2), { account: 'b' })).ok, false, 'dead pid');
  assert.equal((await w.wake(uuid(4), { account: 'b' })).ok, false, 'only <pid>.json files count');
  assert.equal((await w.wake(uuid(5), { account: 'b' })).ok, false);
  assert.equal(w.calls.length, 0);
  assert.equal((await w.wake(T1, { account: 'b' })).ok, true, 'a bad file does not break the lookup');
});

test('the .key files and anything but <pid>.json are never opened', async (t) => {
  const w = mk(t);
  const spy = spyFs(w.reg.dir);
  const r = await w.wake(T1, { account: 'b' });
  spy.stop();
  assert.equal(r.ok, true);
  const bad = spy.touched.filter((p) => !/[\\/]\d+\.json$/.test(p) && path.resolve(p) !== path.resolve(w.reg.dir));
  assert.deepEqual(bad, []);
});

test('chat name rules: needs 1-100 chars, no control characters, not agent-monitor; exactly one live entry', async (t) => {
  const bad = ['', 'a'.repeat(101), 'tab\there', 'line\nbreak', 'bell\u0007', 'agent-monitor', undefined, 5, null];
  for (const name of bad) {
    const w = mk(t, { entries: [{ ...ENTRY, name }] });
    const r = await w.wake(T1, { account: 'b' });
    assert.equal(r.ok, false, JSON.stringify(name));
    assert.equal(r.found, true, JSON.stringify(name));
    assert.equal(w.calls.length, 0);
  }
  const edge = mk(t, { entries: [{ ...ENTRY, name: 'n'.repeat(100) }] });
  assert.equal((await edge.wake(T1, { account: 'b' })).ok, true, '100 chars is allowed');
  const one = mk(t, { entries: [{ ...ENTRY, name: 'x' }] });
  assert.equal((await one.wake(T1, { account: 'b' })).ok, true, 'a single character is allowed');
  const dup = mk(t, { entries: [ENTRY, { pid: 41009, sessionId: uuid(9), name: 'Nike Board' }] });
  const r = await dup.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.reason, dup.calls.length], [false, 'ambiguous name', 0]);
  const ghost = mk(t, { entries: [ENTRY, { pid: 41009, sessionId: uuid(9), name: 'Nike Board', dead: true }] });
  assert.equal((await ghost.wake(T1, { account: 'b' })).ok, true, 'a dead entry with the same name does not make it ambiguous');
});

test('a busy chat is waited for until idle; one that never goes idle fails with no spawn', async (t) => {
  const w = mk(t);
  w.reg.patch(41001, { status: 'busy', statusUpdatedAt: Date.now() });
  let flipped = 0;
  setTimeout(() => { flipped = Date.now(); w.reg.patch(41001, { status: 'idle', statusUpdatedAt: Date.now() }); }, 70);
  const r = await w.wake(T1, { account: 'b' });
  assert.equal(r.ok, true);
  assert.ok(flipped > 0 && w.calls[0].spawnedAt >= flipped - 5, 'helper starts only after the chat is idle');
  const stuck = mk(t, { opts: { idleWaitMs: 80 } });
  stuck.reg.patch(41001, { status: 'busy', statusUpdatedAt: Date.now() });
  const r2 = await stuck.wake(T1, { account: 'b' });
  assert.deepEqual([r2.ok, r2.found, stuck.calls.length], [false, true, 0]);
});

test('delivery is confirmed from the registry, not from the tool result', async (t) => {
  const none = mk(t, { behave: (reg) => delivering(reg, { touch: false }), opts: { confirmWaitMs: 80 } });
  const r = await none.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.reason, r.found], [false, 'not delivered', true]);
  assert.equal(none.calls.length, 1);
  // late touch, still inside the confirm window
  const late = mk(t, {
    behave: (reg) => delivering(reg, { touch: false, extra: () => setTimeout(() => reg.patch(41001, { status: 'busy', statusUpdatedAt: Date.now() + 50 }), 40) }),
    opts: { confirmWaitMs: 400 },
  });
  assert.equal((await late.wake(T1, { account: 'b' })).ok, true);
  // already back to idle but updated after the spawn counts
  const back = mk(t, { behave: (reg) => delivering(reg, { status: 'idle' }) });
  assert.equal((await back.wake(T1, { account: 'b' })).ok, true);
  // an update from before the spawn does not count
  const old = mk(t, { behave: (reg) => delivering(reg, { touch: false, extra: () => reg.patch(41001, { status: 'busy', statusUpdatedAt: Date.now() - 5000 }) }), opts: { confirmWaitMs: 80 } });
  assert.equal((await old.wake(T1, { account: 'b' })).reason, 'not delivered');
});

test('a held message is reported as held, even though the tool result says success', async (t) => {
  const w = mk(t, { behave: (reg) => delivering(reg, { touch: false, held: true }) });
  const r = await w.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.reason, r.found], [false, 'held', true]);
});

test('helper failures: tool result success:false, result without a tool result, junk output, nonzero exit', async (t) => {
  const failed = mk(t, { behave: (reg) => delivering(reg, { success: false }) });
  assert.equal((await failed.wake(T1, { account: 'b' })).ok, false);
  const noTool = mk(t, { behave: () => (call) => { emit(call, initEv()); emit(call, resultEv); finish(call, 0); } });
  assert.equal((await noTool.wake(T1, { account: 'b' })).ok, false, 'result.subtype success alone is not delivery');
  const garbage = mk(t, { behave: () => (call) => { emit(call, initEv()); emit(call, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'not json {' }] }] } }); emit(call, resultEv); finish(call, 0); } });
  assert.equal((await garbage.wake(T1, { account: 'b' })).ok, false);
  const crash = mk(t, { behave: () => (call) => { call.child.stderr.write('boom'); finish(call, 1); } });
  assert.equal((await crash.wake(T1, { account: 'b' })).ok, false);
});

test('stream parsing copes with split chunks, junk lines and a runaway line', async (t) => {
  const split = mk(t, {
    behave: (reg) => (call) => {
      const line = `${JSON.stringify(toolResult(true))}\n`;
      emit(call, initEv());
      emit(call, toolUse('toolu_1', promptInput(call)));
      call.child.stdout.write('this is not json\n\n');
      reg.patch(41001, { status: 'busy', statusUpdatedAt: Date.now() + 50 });
      call.child.stdout.write(line.slice(0, 40));
      setTimeout(() => { call.child.stdout.write(line.slice(40)); emit(call, resultEv); finish(call, 0); }, 15);
    },
  });
  assert.equal((await split.wake(T1, { account: 'b' })).ok, true);
  const runaway = mk(t, { behave: () => (call) => { call.child.stdout.write('x'.repeat(2 * 1024 * 1024)); finish(call, 0); } });
  const r = await runaway.wake(T1, { account: 'b' });
  assert.equal(r.ok, false);
});

test('spawn error event, and a spawn that throws, both resolve ok:false (never reject)', async (t) => {
  const w = mk(t, { behave: () => (call) => call.child.emit('error', new Error('ENOENT')) });
  assert.equal((await w.wake(T1, { account: 'b' })).ok, false);
  const reg = makeRegistry(); reg.write(ENTRY);
  const wake = createChatWake({ sessionsDir: reg.dir, command: 'x', spawn: () => { throw new Error('nope'); }, modeOf: () => 'bypassPermissions', isAlive: reg.isAlive, pollMs: 10, idleWaitMs: 100, confirmWaitMs: 50 });
  t.after(() => wake.close());
  const r = await wake.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.found], [false, true]);
});

test('a helper that never finishes is killed at the timeout', async (t) => {
  const w = mk(t, { behave: () => (call) => emit(call, initEv()), opts: { helperTimeoutMs: 120 } });
  const t0 = Date.now();
  const r = await w.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.reason, r.found], [false, 'timeout', true]);
  assert.ok(Date.now() - t0 < 3000);
  assert.deepEqual(w.kills, [w.calls[0].child.pid], 'killTree is called with the helper pid');
});

test('dedupe: a wake in flight is shared; a finished one blocks a repeat; the window expires; other sessions are independent', async (t) => {
  const reg2 = { pid: 41002, sessionId: uuid(2), name: 'Other Chat' };
  const w = mk(t, { entries: [ENTRY, reg2], modes: { [T1]: 'bypassPermissions', [uuid(2)]: 'bypassPermissions' }, opts: { dedupeMs: 150 } });
  const [a, b] = await Promise.all([w.wake(T1, { account: 'b' }), w.wake(T1, { account: 'b' })]);
  assert.deepEqual({ ...a, quiet: undefined }, { ...b, quiet: undefined });
  assert.equal(b.quiet, true, 'the joiner gets quiet:true');
  assert.equal(w.calls.length, 1, 'one helper for two concurrent wakes');
  const again = await w.wake(T1, { account: 'b' });
  assert.deepEqual([again.ok, again.reason], [false, 'woken recently']);
  assert.equal(w.calls.length, 1);
  assert.equal((await w.wake(uuid(2), { account: 'b' })).ok, true, 'a different chat is woken as well');
  assert.equal(w.calls.length, 2);
  await sleep(200);
  w.reg.patch(41001, { status: 'idle' });
  assert.equal((await w.wake(T1, { account: 'b' })).ok, true, 'after the window it can be woken again');
});

test('loop guard: helper session ids are registered at init, before anything else, and are never woken', async (t) => {
  const w = mk(t, {
    entries: [ENTRY, { pid: 41050, sessionId: HELPER_ID, name: 'agent-monitor' }],
    behave: () => (call) => emit(call, initEv(HELPER_ID)), // then hangs
    opts: { helperTimeoutMs: 400 },
  });
  assert.deepEqual((await w.wake(uuid(555), { account: 'b' })).found, false);
  assert.equal(w.calls.length, 0);
  assert.equal(w.isHelper(HELPER_ID), false);
  const p = w.wake(T1, { account: 'b' });
  assert.ok(await until(() => w.isHelper(HELPER_ID)), 'known as soon as init arrives, while the helper is still running');
  const r = await p;
  assert.equal(r.ok, false);
  assert.equal(w.isHelper(HELPER_ID), true, 'still known after the helper was killed');
  assert.equal(w.isHelper(T1), false);
  for (const junk of [undefined, null, 5, {}, '', 'x']) assert.equal(w.isHelper(junk), false);
  const guarded = await w.wake(HELPER_ID, { account: 'b' });
  assert.equal(guarded.ok, false);
  assert.equal(w.calls.length, 1, 'no helper was started for a helper');
});

test('concurrency: at most maxConcurrent helpers run; the rest queue and then run as slots free up', async (t) => {
  const ids = [1, 2, 3, 4].map(uuid);
  const entries = ids.map((id, i) => ({ pid: 42001 + i, sessionId: id, name: `Chat ${i}` }));
  const modes = Object.fromEntries(ids.map((id) => [id, 'bypassPermissions']));
  const parked = [];
  const w = mk(t, { entries, modes, behave: () => (call) => parked.push(call) });
  const ps = ids.map((id) => w.wake(id, { account: 'b' }));
  await until(() => parked.length >= 2);
  await sleep(80);
  assert.equal(w.calls.length, 2, 'default maxConcurrent is 2');
  const finishOk = (call) => {
    const to = JSON.parse(/^\{"to":.*\}$/m.exec(call.stdin)[0]).to;
    const e = entries.find((x) => x.name === to);
    w.reg.patch(e.pid, { status: 'busy', statusUpdatedAt: Date.now() + 50 });
    emit(call, initEv(uuid(800 + parked.indexOf(call)))); emit(call, toolUse('toolu_1', promptInput(call))); emit(call, toolResult(true)); emit(call, resultEv); finish(call, 0);
  };
  finishOk(parked[0]);
  await until(() => parked.length >= 3);
  await sleep(40);
  assert.equal(w.calls.length, 3);
  // a crashing helper also frees its slot
  finish(parked[1], 1);
  await until(() => parked.length >= 4);
  finishOk(parked[2]); finishOk(parked[3]);
  const rs = await Promise.all(ps);
  assert.equal(rs.filter((r) => r.ok).length, 3);
  assert.equal(rs.filter((r) => !r.ok).length, 1);
});

test('a full queue answers busy at once instead of waiting', async (t) => {
  const ids = [1, 2, 3].map(uuid);
  const entries = ids.map((id, i) => ({ pid: 43001 + i, sessionId: id, name: `Chat ${i}` }));
  const modes = Object.fromEntries(ids.map((id) => [id, 'bypassPermissions']));
  const parked = [];
  const w = mk(t, { entries, modes, opts: { maxConcurrent: 1, maxQueue: 1 }, behave: () => (call) => parked.push(call) });
  const p1 = w.wake(ids[0], { account: 'b' });
  await until(() => parked.length === 1);
  const p2 = w.wake(ids[1], { account: 'b' });
  await sleep(60);
  const r3 = await Promise.race([w.wake(ids[2], { account: 'b' }), sleep(1500).then(() => 'hung')]);
  assert.equal(r3.reason, 'busy');
  assert.equal(r3.ok, false);
  assert.equal(w.calls.length, 1);
  finish(parked[0], 1);
  await p1;
  await until(() => parked.length === 2);
  finish(parked[1], 1);
  assert.equal((await p2).ok, false);
});

test('the helper environment is cleaned: no parent identity, no API keys; config dir and git-bash path kept', async (t) => {
  const env = {
    PATH: '/bin', CLAUDE_CONFIG_DIR: '/cfg', CLAUDE_CODE_GIT_BASH_PATH: 'C:\\git\\bash.exe',
    CLAUDECODE: '1', CLAUDE_CODE_ENTRYPOINT: 'x', CLAUDE_CODE_SSE_PORT: '1', CLAUDE_CODE_MESSAGING_SOCKET: 's', claude_code_lower: 'y', Claude_Code_Mixed: 'z',
    ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'k', CLAUDE_PID: '1', CLAUDE_EFFORT: 'high', CLAUDE_AGENT_SDK_VERSION: '1', KEEP_ME: 'ok',
  };
  const snapshot = { ...env };
  const w = mk(t, { env });
  assert.equal((await w.wake(T1, { account: 'b' })).ok, true);
  const e = w.calls[0].opts.env;
  for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SSE_PORT', 'CLAUDE_CODE_MESSAGING_SOCKET', 'claude_code_lower', 'Claude_Code_Mixed', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_PID', 'CLAUDE_EFFORT', 'CLAUDE_AGENT_SDK_VERSION']) assert.ok(!(k in e), `${k} must be dropped`);
  assert.equal(e.CLAUDE_CONFIG_DIR, '/cfg');
  assert.equal(e.CLAUDE_CODE_GIT_BASH_PATH, 'C:\\git\\bash.exe');
  assert.equal(e.KEEP_ME, 'ok');
  assert.equal(e.NoDefaultCurrentDirectoryInExePath, '1');
  assert.deepEqual(env, snapshot, 'the caller env object is not mutated');
});

test('results carry only {ok, name, reason, found, quiet}: no registry contents leak', async (t) => {
  const w = mk(t, { behave: (reg) => delivering(reg, { touch: false }), opts: { confirmWaitMs: 40 } });
  const rs = [await w.wake(T1, { account: 'b' }), await w.wake(uuid(99), { account: 'b' })];
  for (const r of rs) {
    assert.ok(Object.keys(r).every((k) => ['ok', 'name', 'reason', 'found', 'quiet'].includes(k)), JSON.stringify(r));
    assert.ok(!JSON.stringify(r).includes('SECRET'));
  }
});

test('close(): kills a running helper, resolves its wake, refuses later wakes, and is idempotent', async (t) => {
  const w = mk(t, { behave: () => (call) => emit(call, initEv()) });
  const p = w.wake(T1, { account: 'b' });
  await until(() => w.calls.length === 1);
  w.close();
  assert.ok(w.kills.includes(w.calls[0].child.pid), 'the running helper is killed');
  const r = await Promise.race([p, sleep(2000).then(() => 'hung')]);
  assert.notEqual(r, 'hung');
  assert.equal(r.ok, false);
  const later = await w.wake(T1, { account: 'b' });
  assert.equal(later.ok, false);
  assert.equal(w.calls.length, 1);
  assert.doesNotThrow(() => w.close());
});

test('close() with a queued wake resolves it too', async (t) => {
  const ids = [1, 2].map(uuid);
  const entries = ids.map((id, i) => ({ pid: 44001 + i, sessionId: id, name: `C${i}` }));
  const modes = Object.fromEntries(ids.map((id) => [id, 'bypassPermissions']));
  const w = mk(t, { entries, modes, opts: { maxConcurrent: 1 }, behave: () => (call) => emit(call, initEv()) });
  const p1 = w.wake(ids[0], { account: 'b' });
  await until(() => w.calls.length === 1);
  const p2 = w.wake(ids[1], { account: 'b' });
  await sleep(50);
  w.close();
  const rs = await Promise.race([Promise.all([p1, p2]), sleep(2500).then(() => 'hung')]);
  assert.notEqual(rs, 'hung');
  assert.deepEqual(rs.map((r) => r.ok), [false, false]);
  assert.equal(w.calls.length, 1, 'the queued one never spawns after close');
});

test('a missing sessions folder resolves ok:false instead of throwing', async (t) => {
  const reg = makeRegistry();
  const wake = createChatWake({ sessionsDir: path.join(reg.dir, 'nope'), command: 'x', spawn: makeSpawn(), modeOf: () => 'bypassPermissions', isAlive: () => true });
  t.after(() => wake.close());
  const r = await wake.wake(T1, { account: 'b' });
  assert.deepEqual([r.ok, r.found], [false, false]);
});
