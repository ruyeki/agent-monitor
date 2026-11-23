// The Accounts API inside the real server (startServer with the accounts option): temp home and data dirs, a memory
// vault and the stub claude only. Fake tokens only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { tmp as tmpDir, advance, jsonHeaders } from './helpers.js';
import { until } from './codex-helpers.js';
import { world, oauth, tmp, readLog, win, secs, NOW, DAY } from './accounts-helpers.js';

// security-accounts.test.js sweeps every new am-claude-* dir in the shared temp dir: this file's sign-in profiles live in a private one.
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-wiretmp-'));
for (const k of ['TMPDIR', 'TEMP', 'TMP']) process.env[k] = PRIVATE_TMP;
after(() => fs.rmSync(PRIVATE_TMP, { recursive: true, force: true }));

const STUB = path.join(import.meta.dirname, 'fixtures', 'accounts-api-claude-stub.mjs');
const HOUR = 3600_000;
const RYAN = oauth('uuid-ryan', { expiresAt: Date.now() + 8 * HOUR });
const LAB = oauth('uuid-lab');
const SECRET = /FAKE|sk-ant|accountUuid|uuid-|refreshToken|accessToken/;

async function boot(t, { accounts = true, cfg = {} } = {}) {
  const log = path.join(tmp(t, 'am-wirelog-'), 'stub.log');
  const env = { ...process.env, AM_API_LOG: log, AM_API_STUB: JSON.stringify(cfg) };
  const w = world(t, {
    accounts: { ryan: RYAN, lab: LAB }, live: RYAN, claude: { command: process.execPath, args: [STUB] }, env,
    usage: { ryan: { reading: { five_hour: win(40, secs(NOW + 3 * HOUR)), seven_day: win(20, secs(NOW + 3 * DAY)), at: new Date(NOW - 600_000).toISOString() } } },
  });
  const s = await startServer({
    port: 0, dataDir: tmpDir(), projectsDir: tmpDir(), webDir: path.join(tmpDir(), 'missing'), usageIntervalMs: 60_000,
    accounts: accounts ? { manager: w.m, notify: () => {} } : null,
  });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await s.close(); } };
  t.after(close);
  const events = [];
  s.store.bus.on('change', (e) => events.push(e));
  const bodies = [];
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(s.url + p, { method, headers: body === undefined ? headers : { ...jsonHeaders, ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: text ? JSON.parse(text) : null };
  };
  return { s, w, events, bodies, call, close, calls: () => readLog(log).filter((l) => l.argv) };
}

test('GET /api/accounts through the server: C11 shape, liveRuns = active + waiting Claude runs, no secrets', async (t) => {
  const { s, call, bodies } = await boot(t);
  s.store.startRun({ title: 'Working', task: 't', repo: 'r', branch: 'b' }); // active
  s.store.startRun({ title: 'Asking', task: 't', repo: 'r', branch: 'b' });
  advance(s.store, 'asking', 'gate1'); // waiting on a gate
  s.store.startRun({ title: 'Stopped', task: 't', repo: 'r', branch: 'b' });
  s.store.stopRun('stopped');
  s.store.startRun({ title: 'On codex', task: 't', repo: 'r', branch: 'b' });
  s.store.handOver('on-codex');
  assert.deepEqual(s.store.listRuns().map((r) => [r.id, r.status, r.provider]).sort(), [
    ['asking', 'waiting', 'claude'], ['on-codex', 'active', 'codex'], ['stopped', 'stopped', 'claude'], ['working', 'active', 'claude'],
  ]);

  const r = await call('GET', '/api/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(Object.keys(r.body).sort(), ['accounts', 'enabled', 'liveReason', 'liveRuns', 'refresh', 'signIn']);
  assert.equal(r.body.enabled, true);
  assert.equal(r.body.liveRuns, 2);
  assert.equal(r.body.refresh, null);
  assert.equal(r.body.signIn, null);
  const ryan = r.body.accounts.find((a) => a.name === 'ryan');
  assert.equal(ryan.active, true);
  assert.equal(ryan.status, 'available');
  assert.equal(ryan.fiveHour, 40);
  assert.equal(r.body.accounts.find((a) => a.name === 'lab').status, 'no-reading');
  assert.doesNotMatch(bodies.join('\n'), SECRET);
});

test('POST /api/accounts/use through the server switches the live login and emits a usage change', async (t) => {
  const { w, call, events } = await boot(t);
  const before = events.length;
  const r = await call('POST', '/api/accounts/use', { name: 'lab' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { from: 'ryan', to: 'lab', switched: true });
  assert.equal(JSON.parse(w.live()).claudeAiOauth.refreshToken, LAB.refreshToken);
  assert.ok(events.slice(before).some((e) => e.type === 'usage'), 'a usage change went on the bus');
  assert.equal((await call('GET', '/api/accounts')).body.accounts.find((a) => a.name === 'lab').active, true);
});

test('a foreign Origin, a missing JSON content type or a bad body is refused before any child starts or any switch', async (t) => {
  const { w, call, calls } = await boot(t, { cfg: { login: 'hang' } });
  const live = w.live();
  const evil = { Origin: 'http://evil.example' };
  assert.equal((await call('POST', '/api/accounts/add', { name: 'newbie' }, evil)).status, 403);
  assert.equal((await call('POST', '/api/accounts/use', { name: 'lab' }, evil)).status, 403);
  assert.equal((await call('POST', '/api/accounts/refresh', {}, evil)).status, 403);
  assert.equal((await call('GET', '/api/accounts', undefined, evil)).status, 403);
  const plain = { 'Content-Type': 'text/plain' };
  assert.equal((await call('POST', '/api/accounts/add', { name: 'newbie' }, plain)).status, 415);
  assert.equal((await call('POST', '/api/accounts/use', { name: 'lab' }, plain)).status, 415);
  assert.equal((await call('POST', '/api/accounts/refresh', {}, plain)).status, 415);
  const form = { 'Content-Type': 'application/x-www-form-urlencoded' };
  assert.equal((await call('POST', '/api/accounts/add', 'name=newbie', form)).status, 415);
  assert.equal((await call('POST', '/api/accounts/add', '{nope')).status, 400, 'invalid JSON');
  assert.equal((await call('POST', '/api/accounts/use', { name: 'lab', pad: 'x'.repeat(5000) })).status, 413);
  await new Promise((r) => setTimeout(r, 300)); // a child that slipped through would have logged by now
  assert.equal(calls().length, 0, 'no claude child started');
  assert.equal(w.live(), live, 'the live login is unchanged');
  assert.equal((await call('GET', '/api/accounts')).body.signIn, null);
});

test('accounts off (no accounts option): GET says enabled false, every POST is a 409', async (t) => {
  const { call, calls } = await boot(t, { accounts: false });
  const r = await call('GET', '/api/accounts');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { enabled: false, accounts: [], liveReason: null, liveRuns: 0, refresh: null, signIn: null });
  for (const p of ['/api/accounts/use', '/api/accounts/refresh', '/api/accounts/add', '/api/accounts/add/code', '/api/accounts/add/cancel']) {
    const x = await call('POST', p, { name: 'lab' });
    assert.equal(x.status, 409, p);
    assert.match(x.body.error, /turned off/);
  }
  assert.equal(calls().length, 0);
  assert.equal((await call('GET', '/api/runs')).status, 200, 'the other routes still answer');
});

test('closing the server stops a running sign-in and removes its temp profile', async (t) => {
  const { call, calls, close } = await boot(t, { cfg: { login: 'hang' } });
  assert.equal((await call('POST', '/api/accounts/add', { name: 'newbie' })).status, 202);
  assert.ok(await until(async () => (await call('GET', '/api/accounts')).body.signIn?.state === 'waiting', 8000), 'the sign-in is waiting');
  const child = calls().find((c) => c.argv[0] === 'auth');
  await close();
  const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
  assert.ok(await until(() => gone(child.pid) && !fs.existsSync(child.configDir), 3000), 'child killed, temp profile removed');
});
