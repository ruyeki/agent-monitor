// Accounts page API (C11) over HTTP, with temp homes, a memory vault and the stub claude only. Fake tokens only.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAccountsApi, statusOf, accountView } from '../src/accounts/api.js';
import { allowedUrl, findSignInUrl } from '../src/accounts/signin.js';
import { liveEnv, LIVE_ARGS } from '../src/accounts/refresh.js';
import { loadRegistry, saveRegistry, readUsage } from '../src/accounts/state.js';
import { until } from './codex-helpers.js';
import { world, oauth, tmp, readLog, win, secs, credsText, NOW, DAY } from './accounts-helpers.js';

// security-accounts.test.js (A3) sweeps every new am-claude-* dir in the shared temp dir, also a parallel file's live
// sign-in profile: this file's temp dirs live in a private one.
const PRIVATE_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-apitmp-'));
for (const k of ['TMPDIR', 'TEMP', 'TMP']) process.env[k] = PRIVATE_TMP;
after(() => fs.rmSync(PRIVATE_TMP, { recursive: true, force: true }));

const STUB = path.join(import.meta.dirname, 'fixtures', 'accounts-api-claude-stub.mjs');
const HOUR = 3600_000;
const iso = (ms) => new Date(ms).toISOString();
// The live login is valid by the real clock (the stub refreshes only an expired one, as Claude Code does).
const RYAN = oauth('uuid-ryan', { expiresAt: Date.now() + 8 * HOUR });
const LAB = oauth('uuid-lab');
const ORDERS = oauth('uuid-orders');
const GONE = oauth('uuid-gone');
const GOOD_URL = 'https://claude.com/cai/oauth/authorize?code=true&client_id=stub-client&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&scope=user%3Ainference&code_challenge=stub&code_challenge_method=S256&state=stubstate';
const INFO = { status: 'allowed', resetsAt: secs(Date.now() + 3 * HOUR), rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: secs(Date.now() + 3 * HOUR) }, seven_day: { utilization: 0.17, resetsAt: secs(Date.now() + 3 * DAY) } } };
const SECRET = /FAKE|sk-ant|accountUuid|uuid-|refreshToken|accessToken/;

// A world whose claude is the stub (cfg in env, changeable per test), plus the API behind a tiny HTTP server.
async function setup(t, { cfg = {}, accounts = { ryan: RYAN, lab: LAB }, live = RYAN, usage = {}, manager, api = {} } = {}) {
  const log = path.join(tmp(t, 'am-apilog-'), 'stub.log');
  const env = { ...process.env, AM_API_LOG: log, AM_API_STUB: JSON.stringify(cfg), CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-env-token', ANTHROPIC_API_KEY: 'FAKE-env-key' };
  const w = world(t, { accounts, live, usage, claude: { command: process.execPath, args: [STUB] }, env });
  const emits = [];
  const bodies = [];
  const a = createAccountsApi({ manager: manager === undefined ? w.m : manager, clock: () => NOW, emit: () => emits.push(Date.now()), liveRuns: () => 2, ...api });
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const readJson = async () => {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return {};
      try { return JSON.parse(raw); } catch { throw Object.assign(new Error('Body is not valid JSON.'), { status: 400 }); }
    };
    try {
      if (!(await a.handle(req, res, url, readJson))) { res.writeHead(404); res.end('{"error":"Not found."}'); }
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status ?? 500); res.end(JSON.stringify({ error: e.message })); } }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { a.close(); server.closeAllConnections(); await new Promise((r) => server.close(r)); });
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, { method, headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers }, body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) });
    const text = await res.text();
    bodies.push(text);
    return { status: res.status, body: JSON.parse(text) };
  };
  return {
    ...w, api: a, env, emits, bodies, calls: () => readLog(log).filter((l) => l.argv), codes: () => readLog(log).filter((l) => 'code' in l).map((l) => l.code),
    setCfg: (c) => { env.AM_API_STUB = JSON.stringify(c); },
    get: () => call('GET', '/api/accounts'), post: (p, b = {}, h) => call('POST', p, b, h),
    signIn: async () => (await call('GET', '/api/accounts')).body.signIn,
  };
}
const gone = (pid) => { try { process.kill(pid, 0); return false; } catch { return true; } };
const loginCall = (s) => s.calls().find((c) => c.argv[0] === 'auth');
async function settled(s, ms = 8000) { return until(async () => { const v = await s.signIn(); return v && !['starting', 'waiting', 'checking', 'saving'].includes(v.state) ? v : null; }, ms); }
async function waitFor(s, pred, ms = 8000) { return until(async () => { const v = await s.signIn(); return v && pred(v) ? v : null; }, ms); }

// ---- pure pieces ----

test('allowedUrl / findSignInUrl: only https links on Anthropic hosts, whole links only', () => {
  for (const u of ['https://claude.com/cai/oauth/authorize?x=1', 'https://claude.ai/login', 'https://console.anthropic.com/oauth', 'https://platform.claude.com/x']) assert.equal(allowedUrl(u), new URL(u).href, u);
  for (const u of ['http://claude.com/x', 'https://claude.com.evil.example/x', 'https://evil.example/?u=https://claude.com/', 'https://notclaude.ai/x',
    'https://user:pw@claude.ai/x', 'https://claude.ai:8443/x', 'javascript:alert(1)', `https://claude.com/${'a'.repeat(2100)}`, '', null]) assert.equal(allowedUrl(u), null, String(u));
  assert.equal(findSignInUrl('visit: https://evil.example/a\nvisit: https://claude.ai/b\n'), 'https://claude.ai/b');
  assert.equal(findSignInUrl('visit: https://claude.com/cai/oa'), null, 'a link cut by a chunk edge is not taken yet');
  assert.equal(findSignInUrl('nothing here\n'), null);
});

test('statusOf / accountView: status words, left null without a reading, no secret fields', () => {
  const base = { name: 'a', email: 'a@x.com', accountUuid: 'uuid-a', active: false, saved: true, reading: null, limit: null, fiveHour: null, sevenDay: null, fiveHourResetsAt: null, sevenDayResetsAt: null, left: 100, limitedUntil: null, available: true, refreshExpiresAt: null };
  assert.equal(statusOf({ ...base, saved: false }), 'no-login');
  assert.equal(statusOf(base), 'no-reading');
  assert.equal(statusOf({ ...base, reading: { at: 'x' }, left: 30 }), 'available');
  assert.equal(statusOf({ ...base, reading: { at: 'x' }, left: 0 }), 'limited');
  assert.equal(statusOf({ ...base, limitedUntil: NOW + HOUR }), 'limited');
  const v = accountView({ ...base, reading: { five_hour: win(10, 1), at: '2026-11-18T11:00:00.000Z' }, left: 90 });
  assert.deepEqual(Object.keys(v).sort(), ['active', 'email', 'fiveHour', 'fiveHourResetsAt', 'left', 'limitedUntil', 'name', 'readingAt', 'refreshExpiresAt', 'saved', 'sevenDay', 'sevenDayResetsAt', 'status'].sort());
  assert.equal(v.readingAt, '2026-11-18T11:00:00.000Z');
  assert.equal(accountView(base).left, null);
});

test('liveEnv: the default ~/.claude gets no CLAUDE_CONFIG_DIR, another home gets it; token variables dropped', () => {
  const env = { PATH: '/bin', CLAUDE_CONFIG_DIR: '/somewhere', CLAUDE_CODE_OAUTH_TOKEN: 'x', anthropic_api_key: 'y', ANTHROPIC_AUTH_TOKEN: 'z' };
  const def = liveEnv(env, path.join(os.homedir(), '.claude'));
  assert.equal('CLAUDE_CONFIG_DIR' in def, false);
  assert.equal(def.PATH, '/bin');
  for (const k of ['CLAUDE_CODE_OAUTH_TOKEN', 'anthropic_api_key', 'ANTHROPIC_AUTH_TOKEN']) assert.equal(k in def, false, k);
  assert.equal(liveEnv(env, '/tmp/other-home').CLAUDE_CONFIG_DIR, '/tmp/other-home');
});

// ---- GET ----

test('GET: accounts with status words and readingAt, liveRuns, no tokens / ids / raw readings', async (t) => {
  const R5 = secs(NOW + 3 * HOUR);
  const s = await setup(t, {
    accounts: { ryan: RYAN, lab: LAB, orders: ORDERS, gone: GONE },
    usage: {
      ryan: { reading: { five_hour: win(40, R5), seven_day: win(20, secs(NOW + 3 * DAY)), at: iso(NOW - 600_000) } },
      lab: { reading: { five_hour: win(100, R5), seven_day: null, at: iso(NOW - HOUR) }, limit: { at: iso(NOW - HOUR), resetsAt: R5 } },
    },
  });
  const reg = loadRegistry(s.dataDir);
  reg.accounts.gone.savedAt = null;
  saveRegistry(s.dataDir, reg);
  const { status, body } = await s.get();
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.equal(body.liveRuns, 2);
  assert.equal(body.liveReason, null);
  assert.equal(body.refresh, null);
  assert.equal(body.signIn, null);
  const by = Object.fromEntries(body.accounts.map((a) => [a.name, a]));
  assert.deepEqual(body.accounts.map((a) => a.name), ['gone', 'lab', 'orders', 'ryan']);
  assert.deepEqual(by.ryan, {
    name: 'ryan', email: 'ryan@example.com', active: true, saved: true, status: 'available', fiveHour: 40, sevenDay: 20, fiveHourResetsAt: R5 * 1000,
    sevenDayResetsAt: secs(NOW + 3 * DAY) * 1000, left: 60, limitedUntil: null, refreshExpiresAt: iso(RYAN.refreshTokenExpiresAt), readingAt: iso(NOW - 600_000),
  });
  assert.equal(by.lab.status, 'limited');
  assert.equal(by.lab.limitedUntil, R5 * 1000);
  assert.equal(by.orders.status, 'no-reading');
  assert.equal(by.orders.left, null);
  assert.equal(by.orders.readingAt, null);
  assert.equal(by.gone.status, 'no-login');
  assert.doesNotMatch(s.bodies.join('\n'), SECRET);
  assert.doesNotMatch(s.bodies.join('\n'), /"reading":|"limit":|"available":/);
});

test('accounts off (manager null): enabled false, every POST is a 409 in plain words', async (t) => {
  const s = await setup(t, { manager: null });
  assert.deepEqual((await s.get()).body, { enabled: false, accounts: [], liveReason: null, liveRuns: 2, refresh: null, signIn: null });
  for (const p of ['/api/accounts/use', '/api/accounts/refresh', '/api/accounts/add', '/api/accounts/add/code', '/api/accounts/add/cancel']) {
    const r = await s.post(p, { name: 'lab', code: 'x#y' });
    assert.equal(r.status, 409, p);
    assert.match(r.body.error, /turned off/);
  }
  assert.equal(s.calls().length, 0);
});

test('requests: unknown route 404, not ours -> false, non-object body 400, big body 413, bad JSON 400', async (t) => {
  const s = await setup(t);
  assert.equal((await s.post('/api/accounts/nope')).status, 404);
  assert.equal(await s.api.handle({ method: 'GET', headers: {} }, null, new URL('http://x/api/accountsx'), null), false);
  assert.equal((await s.post('/api/accounts/use', [1, 2])).status, 400);
  assert.equal((await s.post('/api/accounts/use', 'null')).status, 400);
  assert.equal((await s.post('/api/accounts/use', { name: 'lab', pad: 'x'.repeat(5000) })).status, 413);
  assert.equal((await s.post('/api/accounts/use', '{nope')).status, 400);
});

// ---- use ----

test('use: switches the live login, emits, answers {from, to, switched}; errors are plain words', async (t) => {
  const s = await setup(t, { accounts: { ryan: RYAN, lab: LAB, orders: ORDERS } });
  const r = await s.post('/api/accounts/use', { name: 'lab' });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { from: 'ryan', to: 'lab', switched: true });
  assert.equal(JSON.parse(s.live()).claudeAiOauth.refreshToken, LAB.refreshToken);
  assert.ok(s.emits.length >= 1, 'a usage change was emitted');
  assert.deepEqual((await s.post('/api/accounts/use', { name: 'lab' })).body, { from: 'lab', to: 'lab', switched: false });

  assert.equal((await s.post('/api/accounts/use', { name: 'Bad Name' })).status, 400);
  assert.equal((await s.post('/api/accounts/use', {})).status, 400);
  const missing = await s.post('/api/accounts/use', { name: 'nobody' });
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no account named "nobody"/);
  s.vault.entries.delete('account/orders');
  const err = await s.post('/api/accounts/use', { name: 'orders' });
  assert.equal(err.status, 400);
  assert.match(err.body.error, /no saved login for "orders"/);
  assert.equal(JSON.parse(s.live()).claudeAiOauth.refreshToken, LAB.refreshToken, 'a failed switch leaves the live login');
  assert.doesNotMatch(s.bodies.join('\n'), SECRET);
});

// ---- refresh ----

test('refresh: 202, one at a time, live account via the live-reading path (no rotation), saved ones via refresh(name)', async (t) => {
  const s = await setup(t, { cfg: { rateLimit: INFO, hold: 600 } });
  const before = s.live();
  const r = await s.post('/api/accounts/refresh');
  assert.equal(r.status, 202);
  assert.equal(r.body.refresh.running, true);
  assert.equal((await s.post('/api/accounts/refresh')).status, 409, 'a second refresh while one runs');
  const done = await until(async () => { const v = (await s.get()).body.refresh; return v && !v.running ? v : null; }, 15000);
  assert.ok(done, 'the job finished');
  assert.deepEqual(done.results, [{ name: 'ryan', ok: true, error: null }, { name: 'lab', ok: true, error: null }], 'the live account first');
  assert.equal(done.at, iso(NOW));

  const [liveCall, labCall] = s.calls();
  assert.deepEqual(liveCall.argv, LIVE_ARGS);
  assert.equal(liveCall.configDir, s.home, 'the live profile, not a temp one');
  assert.notEqual(liveCall.cwd, s.home);
  assert.equal(fs.existsSync(liveCall.cwd), false, 'the temp cwd was removed');
  assert.equal(liveCall.seenExpiresAt, RYAN.expiresAt, 'the live login was not expired on purpose');
  assert.equal(liveCall.hasOauthToken, false);
  assert.equal(liveCall.hasApiKey, false);
  assert.match(liveCall.stdin, /OK/);
  assert.equal(s.live(), before, 'the live login file is untouched');
  assert.equal(s.vault.entries.get('account/ryan'), JSON.stringify(RYAN), 'nothing rotated or saved for the live account');

  assert.notEqual(labCall.configDir, s.home, 'saved accounts refresh in a temp profile');
  assert.equal(labCall.seenExpiresAt, 0);
  assert.equal(JSON.parse(s.vault.entries.get('account/lab')).refreshToken, `${LAB.refreshToken}-rotated`);

  for (const n of ['ryan', 'lab']) {
    const u = readUsage(s.dataDir, n);
    assert.equal(u.reading.five_hour.used_percentage, 42, n);
    assert.equal(u.reading.at, iso(NOW), n);
  }
  const view = (await s.get()).body.accounts.find((a) => a.name === 'ryan');
  assert.equal(view.readingAt, iso(NOW));
  assert.equal(view.fiveHour, 42);
  assert.ok(s.emits.length >= 2);
  assert.doesNotMatch(s.bodies.join('\n'), SECRET);
});

test('refresh: an unchanged reading is still stamped as taken now; a missing reading is a plain-words result', async (t) => {
  const s = await setup(t, { accounts: { ryan: RYAN }, cfg: { rateLimit: INFO } });
  s.m.recordReading('ryan', { five_hour: win(42, INFO.unifiedWindows.five_hour.resetsAt), seven_day: win(17, INFO.unifiedWindows.seven_day.resetsAt) });
  const usageFile = path.join(s.dataDir, 'accounts', 'usage-ryan.json');
  const u = JSON.parse(fs.readFileSync(usageFile, 'utf8'));
  u.reading.at = iso(NOW - 5 * HOUR);
  fs.writeFileSync(usageFile, JSON.stringify(u));
  await s.post('/api/accounts/refresh');
  assert.ok(await until(async () => (await s.get()).body.refresh?.running === false, 10000));
  assert.equal(readUsage(s.dataDir, 'ryan').reading.at, iso(NOW));

  s.setCfg({ noEvent: true });
  await s.post('/api/accounts/refresh');
  const done = await until(async () => { const v = (await s.get()).body.refresh; return v && !v.running ? v : null; }, 10000);
  assert.deepEqual(done.results, [{ name: 'ryan', ok: false, error: 'Claude Code returned no usage reading (exit 1)' }]);
});

test('refresh: the live account switched during the reading -> nothing recorded for either', async (t) => {
  const s = await setup(t, { cfg: { rateLimit: INFO, hold: 400 }, accounts: { ryan: RYAN } });
  await s.post('/api/accounts/refresh');
  await until(() => s.calls().length > 0, 5000);
  fs.writeFileSync(s.file, credsText(oauth('uuid-stranger')));
  const done = await until(async () => { const v = (await s.get()).body.refresh; return v && !v.running ? v : null; }, 10000);
  assert.equal(done.results[0].ok, false);
  assert.match(done.results[0].error, /live login changed/);
  assert.equal(readUsage(s.dataDir, 'ryan').reading, null);
});

// ---- add (in-browser sign-in) ----

test('add: link from an allowed host only, needsCode, a rejected code, then the right one saves through add()\'s logic', async (t) => {
  const s = await setup(t, { cfg: { hostile: true, split: true, invalidDelay: 400, uuid: 'uuid-new', email: 'new@example.com' } });
  const logs = [];
  const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };
  for (const k of Object.keys(orig)) console[k] = (...a) => logs.push(a);
  t.after(() => Object.assign(console, orig));

  const r = await s.post('/api/accounts/add', { name: 'newbie', email: 'new@example.com' });
  assert.equal(r.status, 202);
  assert.equal(r.body.signIn.name, 'newbie');
  assert.equal(r.body.signIn.startedAt, iso(NOW));
  assert.equal((await s.post('/api/accounts/add', { name: 'other' })).status, 409, 'one sign-in at a time');
  const waiting = await waitFor(s, (v) => v.state === 'waiting' && v.needsCode && v.url);
  assert.ok(waiting, 'waiting for a code with a link');
  assert.equal(waiting.url, GOOD_URL, 'hostile links were skipped, the split link was taken whole');
  assert.deepEqual(loginCall(s).argv, ['auth', 'login', '--claudeai', '--email', 'new@example.com']);
  assert.equal(loginCall(s).hasOauthToken, false);

  assert.equal((await s.post('/api/accounts/add/code', { code: 'x'.repeat(501) })).status, 400);
  assert.equal((await s.post('/api/accounts/add/code', { code: 'a\nb' })).status, 400);
  assert.equal((await s.post('/api/accounts/add/code', { code: '   ' })).status, 400);
  const sent = await s.post('/api/accounts/add/code', { code: 'no-hash-code' });
  assert.equal(sent.status, 200);
  assert.equal(sent.body.signIn.state, 'checking');
  assert.equal((await s.post('/api/accounts/add/code', { code: 'x#y' })).status, 409, 'no code while one is being checked');
  const again = await waitFor(s, (v) => v.state === 'waiting' && v.needsCode && v.error);
  assert.match(again.error, /not accepted/);
  assert.equal((await s.post('/api/accounts/add/code', { code: '  good#stubstate  ' })).status, 200);
  const end = await settled(s);
  assert.deepEqual(end, { state: 'done', name: 'newbie', url: null, needsCode: false, error: null, startedAt: iso(NOW) });

  assert.deepEqual(s.codes(), ['no-hash-code', 'good#stubstate'], 'each code written as one line');
  const saved = JSON.parse(s.vault.entries.get('account/newbie'));
  assert.equal(saved.accountUuid, 'uuid-new');
  assert.equal(saved.organizationUuid, 'org-uuid-new');
  assert.equal(loadRegistry(s.dataDir).accounts.newbie.email, 'new@example.com');
  assert.equal(fs.existsSync(loginCall(s).configDir), false, 'temp profile removed');
  assert.ok(gone(loginCall(s).pid));
  assert.ok((await s.get()).body.accounts.some((a) => a.name === 'newbie' && a.status === 'no-reading'));
  assert.ok(s.emits.length >= 3);
  assert.doesNotMatch(s.bodies.join('\n'), SECRET);
  assert.doesNotMatch(s.bodies.join('\n'), /evil|Invalid code|Login|Paste code/, 'no other Claude Code output passes through');
  assert.deepEqual(logs, [], 'nothing logged');
});

test('add: only hostile links -> no link shown, still asks for a code; the browser redirect finishes with no code', async (t) => {
  const s = await setup(t, { cfg: { hostileOnly: true } });
  await s.post('/api/accounts/add', { name: 'newbie' });
  const w = await waitFor(s, (v) => v.state === 'waiting' && v.needsCode);
  assert.equal(w.url, null);
  await s.post('/api/accounts/add/cancel');
  assert.ok(await until(() => gone(loginCall(s).pid), 3000));

  s.setCfg({ login: 'auto', uuid: 'uuid-auto', email: 'auto@example.com' });
  assert.ok(await until(async () => (await s.post('/api/accounts/add', { name: 'auto' })).status === 202, 5000));
  assert.equal((await settled(s)).state, 'done');
  assert.equal(JSON.parse(s.vault.entries.get('account/auto')).accountUuid, 'uuid-auto');
  assert.equal(loadRegistry(s.dataDir).accounts.auto.email, 'auto@example.com');
});

test('add/cancel: kills Claude Code, saves nothing, removes the temp profile; a new sign-in may start after', async (t) => {
  const s = await setup(t, { cfg: { login: 'hang' } });
  assert.equal((await s.post('/api/accounts/add/cancel')).status, 409, 'nothing to cancel');
  await s.post('/api/accounts/add', { name: 'newbie' });
  await waitFor(s, (v) => v.state === 'waiting');
  const c = await s.post('/api/accounts/add/cancel');
  assert.equal(c.status, 200);
  assert.equal(c.body.signIn.state, 'cancelled');
  const end = await settled(s);
  assert.equal(end.state, 'cancelled');
  assert.equal(end.error, null);
  const call = loginCall(s);
  assert.ok(await until(() => gone(call.pid), 3000), 'the child was killed');
  assert.ok(await until(() => !fs.existsSync(call.configDir), 3000), 'temp profile removed');
  assert.equal(s.vault.entries.has('account/newbie'), false);
  assert.equal(loadRegistry(s.dataDir).accounts.newbie, undefined);
  assert.equal((await s.post('/api/accounts/add/code', { code: 'x#y' })).status, 409, 'no code after a cancel');
  assert.ok(await until(async () => (await s.post('/api/accounts/add', { name: 'again' })).status === 202, 3000));
  await waitFor(s, (v) => v.state === 'waiting');
  await s.post('/api/accounts/add/cancel');
  assert.ok(await until(() => s.calls().every((x) => gone(x.pid)), 3000));
});

test('add: timeout, a refused code and a failed sign-in save nothing and remove the temp profile', async (t) => {
  const s = await setup(t, { cfg: { login: 'hang' }, api: { loginTimeoutMs: 700 } });
  await s.post('/api/accounts/add', { name: 'slow' });
  const t1 = await settled(s);
  assert.equal(t1.state, 'failed');
  assert.match(t1.error, /took too long/);
  const c1 = loginCall(s);
  assert.ok(gone(c1.pid));
  assert.equal(fs.existsSync(c1.configDir), false);

  s.setCfg({ login: 'code' });
  await s.post('/api/accounts/add', { name: 'wrong' });
  await waitFor(s, (v) => v.needsCode);
  await s.post('/api/accounts/add/code', { code: 'bad#stubstate' });
  const t2 = await settled(s);
  assert.equal(t2.state, 'failed');
  assert.equal(t2.error, 'sign-in did not finish (exit 1)');

  s.setCfg({ login: 'fail' });
  await s.post('/api/accounts/add', { name: 'broken' });
  assert.equal((await settled(s)).state, 'failed');
  for (const c of s.calls()) assert.equal(fs.existsSync(c.configDir), false);
  for (const n of ['slow', 'wrong', 'broken']) assert.equal(s.vault.entries.has(`account/${n}`), false, n);
  assert.deepEqual(Object.keys(loadRegistry(s.dataDir).accounts).sort(), ['lab', 'ryan']);
  assert.doesNotMatch(s.bodies.join('\n'), /Login failed|status code 400/);
});

test('add: same identity checks as add() (login already saved, email mismatch); bad name / email -> 400', async (t) => {
  const s = await setup(t, { cfg: { login: 'auto', uuid: 'uuid-lab', email: 'lab@example.com' } });
  await s.post('/api/accounts/add', { name: 'labcopy' });
  const d = await settled(s);
  assert.equal(d.state, 'failed');
  assert.equal(d.error, 'that login is already saved as "lab"');
  assert.equal(s.vault.entries.has('account/labcopy'), false);
  assert.equal(s.vault.entries.get('account/lab'), JSON.stringify(LAB), 'the existing login is untouched');

  s.setCfg({ login: 'auto', uuid: 'uuid-x', email: 'someone@example.com' });
  await s.post('/api/accounts/add', { name: 'x', email: 'wanted@example.com' });
  const m = await settled(s);
  assert.equal(m.state, 'failed');
  assert.match(m.error, /signed in as someone@example.com, not wanted@example.com; nothing was saved/);
  assert.equal(s.vault.entries.has('account/x'), false);

  for (const b of [{}, { name: 'Bad' }, { name: '1abc' }, { name: 'a'.repeat(33) }, { name: 'ok', email: 'not-an-email' }, { name: 'ok', email: `${'a'.repeat(250)}@x.com` }, { name: 'ok', email: 5 }]) {
    assert.equal((await s.post('/api/accounts/add', b)).status, 400, JSON.stringify(b).slice(0, 60));
  }
});

test('close: a running sign-in is stopped and its temp profile removed', async (t) => {
  const s = await setup(t, { cfg: { login: 'hang' } });
  await s.post('/api/accounts/add', { name: 'newbie' });
  await waitFor(s, (v) => v.state === 'waiting');
  s.api.close();
  const call = loginCall(s);
  assert.ok(await until(() => gone(call.pid) && !fs.existsSync(call.configDir), 3000));
  assert.equal(s.vault.entries.has('account/newbie'), false);
});
