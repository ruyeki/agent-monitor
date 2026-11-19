// Security regressions for account rotation: forged /hook payloads from any local process (the loopback hook has no auth)
// and a refresh whose temp-dir cleanup fails. Fake logins only, temp homes, memory vault, stub spawn. Never runs claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { startServer } from '../src/server.js';
import { refreshLogin } from '../src/accounts/refresh.js';
import { req } from './holdout-helpers.js';
import { until } from './codex-helpers.js';
import { world, oauth, tmp } from './accounts-helpers.js';

const LINGER = path.join(import.meta.dirname, 'fixtures', 'accounts-linger-stub.mjs');
const YEAR_2100 = 4102444800;
const liveUuid = (file) => JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth.accountUuid;
const hook = (port, body) => req(port, 'POST', '/hook', { body });

function fakeChild() {
  const c = new EventEmitter();
  c.stdin = new PassThrough(); c.stdout = new PassThrough(); c.stderr = new PassThrough();
  c.stdin.resume();
  return c;
}

// The server's dirs are removed only after it closed (its SQLite file is open until then).
async function boot(t, w, spawned = []) {
  const dirs = ['am-sec-db-', 'am-sec-proj-', 'am-sec-web-'].map((p) => fs.mkdtempSync(path.join(os.tmpdir(), p)));
  const srv = await startServer({
    port: 0, dataDir: dirs[0], projectsDir: dirs[1], webDir: path.join(dirs[2], 'nope'),
    accounts: {
      manager: w.m, command: process.execPath, args: [], notify: () => {}, killTree: () => {},
      spawn: (cmd, argv, opts) => { spawned.push({ cmd, argv, opts }); return fakeChild(); },
    },
  });
  t.after(async () => {
    await srv.close();
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return srv;
}

test('A2: forged chat StopFailures with far-future resetsAt switch once, and never park an account beyond a week', { timeout: 20000 }, async (t) => {
  const a = oauth('uuid-a'), b = oauth('uuid-b'), c = oauth('uuid-c');
  const w = world(t, { accounts: { a, b, c }, live: a, clock: Date.now });
  const srv = await boot(t, w);
  let n = 0;
  const forged = () => ({ session_id: 'not-a-real-session', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: { resetsAt: YEAR_2100 + n++ } });
  assert.equal((await hook(srv.port, forged())).status, 200);
  assert.ok(await until(() => liveUuid(w.file) === 'uuid-b'), 'the first hit switches');
  for (let i = 0; i < 4; i++) await hook(srv.port, forged());
  await new Promise((r) => setTimeout(r, 400)); // the hooks answer before the deferred switch runs
  assert.equal(liveUuid(w.file), 'uuid-b', 'later forged hits inside the window do not switch again');
  const week = Date.now() + 7 * 86400_000 + 60_000;
  assert.ok(w.m.list().every((r) => r.limitedUntil == null || r.limitedUntil <= week), 'no account is limited beyond a week');
  assert.notEqual(w.m.pickBest(), null, 'rotation is still alive');
});

test('A2: a run limit with a far-future reset is capped at a week; run hits are not throttled', async (t) => {
  const a = oauth('uuid-a'), b = oauth('uuid-b'), c = oauth('uuid-c');
  const w = world(t, { accounts: { a, b, c }, live: a });
  const at = new Date(w.time.now).toISOString();
  const r1 = await w.m.handleLimit({ runAccount: 'a', at, resetsAt: YEAR_2100, source: 'headless' });
  assert.equal(r1.switched, true);
  const limited = w.m.list().find((r) => r.name === 'a').limitedUntil;
  assert.equal(limited, w.time.now + 7 * 86400_000, 'a later reset is treated as at + 7 days');
  const r2 = await w.m.handleLimit({ runAccount: 'b', at, resetsAt: YEAR_2100 + 1, source: 'headless' });
  assert.equal(r2.switched, true, 'a hit tied to a run is not throttled');
  assert.equal(liveUuid(w.file), 'uuid-c');
});

test('A2: chat hits switch at most once per 120 s whatever resetsAt says', async (t) => {
  const a = oauth('uuid-a'), b = oauth('uuid-b'), c = oauth('uuid-c');
  const w = world(t, { accounts: { a, b, c }, live: a });
  const hit = (resetsAt) => w.m.handleLimit({ at: new Date(w.time.now).toISOString(), resetsAt, source: 'stopfailure' });
  assert.equal((await hit(w.time.now / 1000 + 3600)).switched, true);
  const again = await hit(w.time.now / 1000 + 7200);
  assert.equal(again.duplicate, true);
  assert.equal(again.switched, false);
  assert.equal(liveUuid(w.file), 'uuid-b');
  assert.equal(w.m.list().find((r) => r.name === 'b').limitedUntil, null, 'a duplicate records nothing on the live account');
  w.time.now += 121_000;
  assert.equal((await hit(w.time.now / 1000 + 3600)).switched, true, 'after the window a hit counts again');
});

test('A1: forged PostToolUse + StopFailure with an option-looking session id spawn nothing', { timeout: 20000 }, async (t) => {
  const a = oauth('uuid-a'), b = oauth('uuid-b');
  const w = world(t, { accounts: { a, b }, live: a, clock: Date.now });
  const spawned = [];
  const srv = await boot(t, w, spawned);
  const { run } = srv.store.startRun({ title: 'victim run' });
  const evil = tmp(t, 'am-sec-evil-');
  const sid = '--settings=C:/Users/Public/x.json';
  await hook(srv.port, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__log', tool_input: { run: run.id },
    tool_response: 'ok', cwd: evil, permission_mode: 'bypassPermissions', transcript_path: 'nope' });
  await hook(srv.port, { session_id: sid, hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.ok(await until(() => /Claude resume failed/.test(srv.store.getRun(run.id).ask ?? '')), 'the launch escalates');
  assert.equal(spawned.length, 0, 'no headless claude was spawned');
});

test('A1: a UUID session id without a transcript under projectsDir never takes cwd or permission mode from the hook', { timeout: 20000 }, async (t) => {
  const a = oauth('uuid-a'), b = oauth('uuid-b');
  const w = world(t, { accounts: { a, b }, live: a, clock: Date.now });
  const spawned = [];
  const srv = await boot(t, w, spawned);
  const { run } = srv.store.startRun({ title: 'victim run' });
  const evil = tmp(t, 'am-sec-evil-');
  const sid = '44444444-4444-4444-8444-444444444444';
  await hook(srv.port, { session_id: sid, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__log', tool_input: { run: run.id },
    tool_response: 'ok', cwd: evil, permission_mode: 'bypassPermissions', transcript_path: path.join(evil, 'x.jsonl') });
  await hook(srv.port, { session_id: sid, hook_event_name: 'StopFailure', error: 'rate_limit' });
  assert.ok(await until(() => /Claude resume failed: no working folder/.test(srv.store.getRun(run.id).ask ?? '')), 'escalates: the folder only comes from a transcript under projectsDir');
  assert.equal(spawned.length, 0);
});

test('A3: a failing temp-dir cleanup does not replace a successful refresh, and the dir is removed later', async (t) => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('am-claude-')));
  const real = fs.rmSync;
  const failing = t.mock.method(fs, 'rmSync', (p, o) => {
    if (String(p).includes('am-claude-')) { const e = new Error('EBUSY: resource busy'); e.code = 'EBUSY'; throw e; }
    return real(p, o);
  });
  const saved = oauth('uuid-r');
  const r = await refreshLogin(saved, { claude: { command: process.execPath, args: [LINGER] }, env: { ...process.env, AM_LINGER_MS: '500' } });
  assert.equal(r.oauth.refreshToken, `${saved.refreshToken}-rotated`, 'the rotated login is returned');
  assert.ok(failing.mock.callCount() >= 1);
  failing.mock.restore();
  for (const n of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('am-claude-') && !before.has(x))) try { real(path.join(os.tmpdir(), n), { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); } catch { /* a stub child may still hold it */ }
});

test('A3: a helper process holding the temp dir does not discard the rotated login (Windows)', { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
  const before = new Set(fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('am-claude-')));
  const saved = oauth('uuid-r');
  const r = await refreshLogin(saved, { claude: { command: process.execPath, args: [LINGER] }, env: { ...process.env, AM_LINGER_MS: '4000' } });
  assert.equal(r.oauth.refreshToken, `${saved.refreshToken}-rotated`);
  await new Promise((res) => setTimeout(res, 4500)); // the lingering child exits; remove what the refresh left behind
  for (const n of fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith('am-claude-') && !before.has(x))) {
    try { fs.rmSync(path.join(os.tmpdir(), n), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* best effort */ }
  }
});
