// Holdout (#2289 piece 4, C11): /api/accounts through startServer. The manager runs over temp dirs, a memory vault and a stub claude.
// Never touches a real login, vault, ~/.claude or ~/.claude.json.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startServer } from '../src/server.js';
import { loadRegistry, saveRegistry } from '../src/accounts/state.js';
import { req, until, sleep, mcpClient, runIdOf } from './holdout-helpers.js';
import { world, oauth, tmp, readLog, win, NOW, DAY } from './accounts-helpers.js';

const STUB = path.join(import.meta.dirname, 'holdout-am-affect-pro-p4-stub.mjs');
const RYAN = oauth('uuid-ryan');
const LAB = oauth('uuid-lab', { refreshTokenExpiresAt: NOW + 3 * DAY });
const ORDERS = oauth('uuid-orders');
const LIM = oauth('uuid-lim');
const GHOST = oauth('uuid-ghost');
const NEW = oauth('uuid-new');
const INFO = { status: 'allowed', resetsAt: 1795059600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1795059600 }, seven_day: { utilization: 0.37, resetsAt: 1795284000 } } };
const GOOD_URL = 'https://claude.ai/oauth/authorize?code=true&client_id=abc&state=xyz';
const SECRETS = /FAKE|sk-ant|accountUuid|uuid-(ryan|lab|orders|lim|ghost|new)|refreshToken|accessToken/;
const n = (x) => (Array.isArray(x) ? x.length : x);

function defaultUsage() {
  return {
    ryan: { reading: { five_hour: win(10, 1795059600), seven_day: win(20, 1795284000), at: new Date(NOW - 10 * 60000).toISOString() } },
    lab: { reading: { five_hour: win(40, 1795059600), seven_day: win(60, 1795284000), at: new Date(NOW - 5 * 60000).toISOString() } },
    lim: { reading: { five_hour: win(100, 1795059600), seven_day: win(30, 1795284000), at: new Date(NOW - 5 * 60000).toISOString() }, limit: { at: new Date(NOW - 60000).toISOString(), resetsAt: 1795059600 } },
  };
}

// A running server with a manager over a temp world. off -> no manager (enabled: false).
async function up(t, { stub = {}, accounts = { ryan: RYAN, lab: LAB, orders: ORDERS, lim: LIM, ghost: GHOST }, live = RYAN, usage, off = false } = {}) {
  const log = path.join(tmp(t, 'am-p4-log-'), 'stub.log');
  const env = { ...process.env, AM_LOGIN_LOG: log, AM_P4_STUB: JSON.stringify(stub), CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-env-token', ANTHROPIC_API_KEY: 'FAKE-env-key', ANTHROPIC_AUTH_TOKEN: 'FAKE-env-auth' };
  const claude = { command: process.execPath, args: [STUB] };
  const w = off ? null : world(t, { accounts, live, usage: usage ?? defaultUsage(), claude, env });
  if (w) { // ghost has no saved login
    const reg = loadRegistry(w.dataDir);
    if (reg.accounts.ghost) { reg.accounts.ghost.savedAt = null; saveRegistry(w.dataDir, reg); w.vault.entries?.delete('account/ghost'); }
  }
  const srv = await startServer({ port: 0, dataDir: tmp(t, 'am-p4-data-'), projectsDir: tmp(t, 'am-p4-proj-'), webDir: path.join(tmp(t, 'am-p4-web-'), 'nope'), accounts: off ? null : { manager: w.m, command: claude, notify() {} } });
  const events = [];
  srv.store.bus.on('change', (e) => events.push(e));
  const texts = [];
  const api = async (m, p, o) => { const r = await req(srv.port, m, p, o); texts.push(r.text); return r; };
  t.after(async () => {
    for (const c of readLog(log)) { if (c.pid) try { process.kill(c.pid); } catch { /* gone */ } }
    await srv.close();
  });
  const calls = () => readLog(log);
  const get = async () => (await api('GET', '/api/accounts')).json;
  const byName = (j, name) => j.accounts.find((a) => a.name === name);
  const everything = () => texts.join('\n');
  return { srv, w, api, calls, get, byName, events, everything, log };
}

const startAdd = (S, name = 'newone', body = {}) => S.api('POST', '/api/accounts/add', { body: { name, ...body } });
const stopAdd = async (S) => { await S.api('POST', '/api/accounts/add/cancel', { body: {} }); await sleep(150); };

test('GET /api/accounts: the documented shape, statuses per account, no readingAt without a reading, nothing secret', async (t) => {
  const S = await up(t);
  const r = await S.api('GET', '/api/accounts');
  assert.equal(r.status, 200);
  const j = r.json;
  assert.equal(j.enabled, true);
  assert.deepEqual(j.accounts.map((a) => a.name).sort(), ['ghost', 'lab', 'lim', 'orders', 'ryan']);
  for (const k of ['name', 'email', 'active', 'saved', 'status', 'fiveHour', 'sevenDay', 'fiveHourResetsAt', 'sevenDayResetsAt', 'left', 'limitedUntil', 'refreshExpiresAt', 'readingAt']) {
    for (const a of j.accounts) assert.ok(k in a, `${a.name} lacks ${k}`);
  }
  assert.equal(S.byName(j, 'ryan').active, true);
  assert.equal(j.accounts.filter((a) => a.active).length, 1);
  assert.equal(S.byName(j, 'ryan').status, 'available');
  const lab = S.byName(j, 'lab');
  assert.equal(lab.status, 'available');
  assert.equal(lab.fiveHour, 40);
  assert.equal(lab.sevenDay, 60);
  assert.ok(lab.fiveHourResetsAt != null && lab.sevenDayResetsAt != null);
  assert.ok(lab.readingAt, 'readingAt for an account with a reading');
  assert.ok(Number.isFinite(Date.parse(lab.readingAt)) || Number.isFinite(lab.readingAt), 'readingAt is a time');
  const orders = S.byName(j, 'orders');
  assert.equal(orders.status, 'no-reading');
  assert.equal(orders.fiveHour, null);
  assert.equal(orders.sevenDay, null);
  assert.equal(orders.readingAt, null);
  const lim = S.byName(j, 'lim');
  assert.equal(lim.status, 'limited');
  assert.ok(lim.limitedUntil);
  const ghost = S.byName(j, 'ghost');
  assert.equal(ghost.status, 'no-login');
  assert.equal(ghost.saved, false);
  assert.equal(n(j.liveRuns), 0);
  assert.ok(j.liveReason == null);
  assert.equal(j.refresh, null);
  assert.equal(j.signIn, null);
  assert.doesNotMatch(S.everything(), SECRETS);
  assert.equal(S.calls().length, 0, 'listing never starts claude');
});

test('liveRuns counts runs that are still open', async (t) => {
  const S = await up(t);
  const mcp = await mcpClient(S.srv.url);
  t.after(() => mcp.client.close());
  assert.equal(n((await S.get()).liveRuns), 0);
  const id = runIdOf((await mcp.call('start_run', { title: 'P4 live run' })).text);
  assert.ok(id);
  assert.ok(n((await S.get()).liveRuns) >= 1, 'one open run');
});

test('enabled=false (no manager): GET says so with no accounts, and every POST is 409 in plain words', async (t) => {
  const S = await up(t, { off: true });
  const j = await S.get();
  assert.equal(j.enabled, false);
  assert.deepEqual(j.accounts, []);
  for (const [p, body] of [['use', { name: 'lab' }], ['refresh', {}], ['add', { name: 'zed' }], ['add/code', { code: 'abc' }], ['add/cancel', {}]]) {
    const r = await S.api('POST', `/api/accounts/${p}`, { body });
    assert.equal(r.status, 409, p);
    assert.equal(typeof r.json?.error, 'string', p);
    assert.ok(r.json.error.length > 8, p);
    assert.doesNotMatch(r.json.error, /TypeError|undefined|at .*\.js/, p);
  }
});

test('use: one POST switches the live login, answers {from,to,switched}, emits a usage change, and leaks nothing', async (t) => {
  const S = await up(t);
  const before = S.w.live();
  const r = await S.api('POST', '/api/accounts/use', { body: { name: 'lab' } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { from: 'ryan', to: 'lab', switched: true });
  assert.notEqual(S.w.live(), before);
  assert.match(S.w.live(), /uuid-lab/);
  const j = await S.get();
  assert.equal(S.byName(j, 'lab').active, true);
  assert.equal(S.byName(j, 'ryan').active, false);
  assert.ok(S.events.some((e) => e.type === 'usage'), 'a usage change was emitted');
  // switching to the account that is already live is a no-op, not an error
  const again = await S.api('POST', '/api/accounts/use', { body: { name: 'lab' } });
  assert.equal(again.status, 200);
  assert.equal(again.json.switched, false);
  assert.doesNotMatch(S.everything(), SECRETS);
  assert.equal(S.calls().length, 0, 'a switch never starts claude');
});

test('use: unknown account 404, malformed names 400, an account with no saved login 400; the live login is untouched each time', async (t) => {
  const S = await up(t);
  const before = S.w.live();
  const unknown = await S.api('POST', '/api/accounts/use', { body: { name: 'nobody' } });
  assert.equal(unknown.status, 404);
  assert.equal(typeof unknown.json.error, 'string');
  for (const name of ['Bad Name', '../etc', 'a/b', '', '-x', 'x'.repeat(40), 7, null, ['lab'], { n: 'lab' }]) {
    const r = await S.api('POST', '/api/accounts/use', { body: { name } });
    assert.equal(r.status, 400, JSON.stringify(name));
    assert.equal(typeof r.json.error, 'string');
  }
  const noName = await S.api('POST', '/api/accounts/use', { body: {} });
  assert.equal(noName.status, 400);
  const ghost = await S.api('POST', '/api/accounts/use', { body: { name: 'ghost' } });
  assert.equal(ghost.status, 400);
  assert.match(ghost.json.error, /saved|login|sign/i);
  assert.equal(S.w.live(), before, 'live login untouched');
  assert.doesNotMatch(S.everything(), SECRETS);
});

test('every POST refuses a non-JSON content type, a foreign Origin and a foreign Host, and changes nothing', async (t) => {
  const S = await up(t);
  const before = S.w.live();
  const posts = [['use', { name: 'lab' }], ['refresh', {}], ['add', { name: 'zed' }], ['add/code', { code: 'abc' }], ['add/cancel', {}]];
  for (const [p, body] of posts) {
    const url = `/api/accounts/${p}`;
    const raw = JSON.stringify(body);
    assert.equal((await S.api('POST', url, { rawBody: raw, headers: { 'Content-Type': 'text/plain' } })).status, 415, `${p} text/plain`);
    assert.equal((await S.api('POST', url, { rawBody: raw, headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status, 415, `${p} form`);
    assert.equal((await S.api('POST', url, { rawBody: raw, headers: { 'Content-Type': null } })).status, 415, `${p} none`);
    for (const origin of ['http://evil.example', 'https://claude.ai', 'null', `http://127.0.0.1.evil.example:${S.srv.port}`, 'http://127.0.0.1:1']) {
      assert.equal((await S.api('POST', url, { body, headers: { Origin: origin } })).status, 403, `${p} origin ${origin}`);
    }
    assert.equal((await S.api('POST', url, { body, headers: { Host: 'evil.example' } })).status, 403, `${p} host`);
  }
  assert.equal((await S.api('GET', '/api/accounts', { headers: { Host: 'evil.example' } })).status, 403, 'GET with a foreign Host');
  assert.equal(S.w.live(), before);
  assert.equal(S.calls().length, 0, 'no child was started');
  const j = await S.get();
  assert.equal(j.refresh, null);
  assert.equal(j.signIn, null);
  // the same-origin call still works
  assert.equal((await S.api('POST', '/api/accounts/use', { body: { name: 'lab' }, headers: { Origin: `http://127.0.0.1:${S.srv.port}` } })).status, 200);
});

test('refresh: 202 and a background job; 409 while running; saved non-live accounts refreshed, a failure is reported per account; the live login is never rotated', async (t) => {
  const S = await up(t, { stub: { rateLimit: INFO, delayMs: 700, failUuid: 'uuid-orders' } });
  const live0 = S.w.live();
  const ryanVault0 = S.w.vault.entries.get('account/ryan');
  const first = await S.api('POST', '/api/accounts/refresh', { body: {} });
  assert.equal(first.status, 202);
  const second = await S.api('POST', '/api/accounts/refresh', { body: {} });
  assert.equal(second.status, 409, 'one refresh at a time');
  assert.equal(typeof second.json.error, 'string');
  assert.equal((await S.get()).refresh?.running, true, 'GET reports the job as running');
  const done = await until(async () => { const j = await S.get(); return j.refresh && j.refresh.running === false ? j : null; }, 20000, 150);
  assert.ok(done, 'the job finished');
  assert.ok(done.refresh.at, 'finish time recorded');
  const res = (name) => done.refresh.results.find((x) => x.name === name);
  assert.equal(res('lab')?.ok, true);
  assert.equal(res('orders')?.ok, false);
  assert.equal(typeof res('orders').error, 'string');
  assert.doesNotMatch(JSON.stringify(done.refresh), SECRETS);
  if (res('ghost')) assert.equal(res('ghost').ok, false, 'an account with no login cannot be refreshed');
  assert.equal(S.byName(done, 'lab').fiveHour, 15, 'the rate-limit reading was recorded');
  assert.match(S.w.vault.entries.get('account/lab'), /rotated/, 'the rotated login was saved back');
  // the live account: never forced to rotate, whatever path was used
  assert.equal(S.w.live(), live0, 'live .credentials.json untouched');
  assert.equal(S.w.vault.entries.get('account/ryan'), ryanVault0, 'live account vault entry untouched');
  const calls = S.calls();
  assert.ok(calls.length >= 2);
  for (const c of calls) {
    assert.notEqual(c.configDir, null, 'claude always gets an explicit CLAUDE_CONFIG_DIR (never the real ~/.claude)');
    assert.equal(c.hasEnvTokens, false, 'no token env reaches claude');
    assert.notEqual(c.cwd.toLowerCase(), os.homedir().toLowerCase());
    if (c.configDir.toLowerCase() === S.w.home.toLowerCase()) assert.notEqual(c.seenExpiresAt, 0, 'the live profile was never forced to expire');
  }
  assert.ok(S.events.some((e) => e.type === 'usage'), 'a usage change was emitted when the job ended');
  // a new job can start after the first ended
  assert.equal((await S.api('POST', '/api/accounts/refresh', { body: {} })).status, 202);
});

test('add: 202, the sign-in URL comes from claude, a pasted code reaches its stdin, the account is saved; one sign-in at a time; no code or token in any response', async (t) => {
  const CODE = 'zZ9-code_ABC1234';
  const S = await up(t, { stub: { url: GOOD_URL, needsCode: true, expectCode: CODE, oauth: NEW, email: 'new@example.com' } });
  const reg0 = Object.keys(loadRegistry(S.w.dataDir).accounts);
  const r = await startAdd(S, 'newone', { email: 'new@example.com' });
  assert.equal(r.status, 202);
  const waiting = await until(async () => { const j = await S.get(); return j.signIn?.needsCode ? j : null; }, 10000, 100);
  assert.ok(waiting, 'needsCode shows up');
  assert.equal(waiting.signIn.name, 'newone');
  assert.equal(waiting.signIn.url, GOOD_URL);
  assert.ok(waiting.signIn.state);
  assert.ok(waiting.signIn.startedAt);
  const call = S.calls().find((c) => c.login);
  assert.deepEqual(call.argv.slice(0, 3), ['auth', 'login', '--claudeai']);
  assert.ok(call.argv.includes('new@example.com'), 'the email is passed on');
  assert.notEqual(call.configDir.toLowerCase(), S.w.home.toLowerCase(), 'sign-in uses a temp profile, not the live one');
  assert.equal(call.hasEnvTokens, false);
  assert.equal((await startAdd(S, 'another')).status, 409, 'one sign-in at a time');
  // bad codes: refused before they reach the child
  for (const code of ['', 'a\nb', 'a\r\nb', 'x'.repeat(501), 5, null, undefined]) {
    const bad = await S.api('POST', '/api/accounts/add/code', { body: { code } });
    assert.ok(bad.status >= 400 && bad.status < 500, `bad code ${JSON.stringify(code)?.slice(0, 20)} -> ${bad.status}`);
  }
  assert.equal(readLog(S.log).filter((l) => 'code' in l).length, 0, 'no refused code reached the child');
  const ok = await S.api('POST', '/api/accounts/add/code', { body: { code: CODE } });
  assert.ok(ok.status === 200 || ok.status === 202, `code accepted (${ok.status})`);
  const done = await until(async () => { const j = await S.get(); const a = S.byName(j, 'newone'); return a?.saved ? j : null; }, 15000, 150);
  assert.ok(done, 'the new account was saved');
  assert.equal(S.byName(done, 'newone').email, 'new@example.com');
  assert.ok(S.w.vault.entries.get('account/newone'), 'saved to the vault');
  assert.deepEqual(Object.keys(loadRegistry(S.w.dataDir).accounts).sort(), [...reg0, 'newone'].sort());
  assert.equal(readLog(S.log).filter((l) => l.code === CODE).length, 1, 'the child got the code once');
  assert.equal(fs.existsSync(call.configDir), false, 'temp profile removed');
  assert.equal(done.signIn == null || done.signIn.needsCode !== true, true);
  assert.ok(!S.everything().includes(CODE), 'the pasted code is never echoed');
  assert.doesNotMatch(S.everything(), /FAKE|sk-ant|accountUuid|refreshToken|accessToken/);
  // the live login is still ryan's
  assert.equal((await S.get()).accounts.find((a) => a.active).name, 'ryan');
});

test('add/code with no sign-in waiting for one is refused and reaches nobody; add validates the name before starting anything', async (t) => {
  const S = await up(t, { stub: { url: GOOD_URL, hang: true } });
  const none = await S.api('POST', '/api/accounts/add/code', { body: { code: 'abc' } });
  assert.ok(none.status === 409 || none.status === 400, `no sign-in -> ${none.status}`);
  for (const name of ['Bad Name', '../x', '', 'x'.repeat(40), 3, null]) {
    const r = await startAdd(S, name);
    assert.equal(r.status, 400, JSON.stringify(name));
  }
  assert.equal(S.calls().length, 0, 'no child for a bad name');
  assert.equal((await startAdd(S, 'okname')).status, 202);
  await until(async () => (await S.get()).signIn?.url, 10000, 100);
  // a sign-in that never asked for a code does not take one
  const early = await S.api('POST', '/api/accounts/add/code', { body: { code: 'abc' } });
  assert.ok(early.status === 409 || early.status === 400, `code while not asked -> ${early.status}`);
  assert.equal(readLog(S.log).filter((l) => 'code' in l).length, 0);
  await stopAdd(S);
});

test('add/cancel kills the sign-in, saves nothing, removes the temp profile and frees the slot', async (t) => {
  const S = await up(t, { stub: { url: GOOD_URL, hang: true, oauth: NEW, email: 'new@example.com' } });
  const reg0 = JSON.stringify(Object.keys(loadRegistry(S.w.dataDir).accounts).sort());
  assert.equal((await startAdd(S, 'tobecancelled')).status, 202);
  await until(async () => S.calls().some((c) => c.login), 8000, 80);
  const call = S.calls().find((c) => c.login);
  const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
  assert.ok(alive(call.pid), 'child is running');
  const c = await S.api('POST', '/api/accounts/add/cancel', { body: {} });
  assert.ok(c.status === 200 || c.status === 202, `cancel -> ${c.status}`);
  assert.ok(await until(() => !alive(call.pid), 8000, 80), 'child was killed');
  assert.ok(await until(() => !fs.existsSync(call.configDir), 8000, 80), 'temp profile removed');
  assert.equal(JSON.stringify(Object.keys(loadRegistry(S.w.dataDir).accounts).sort()), reg0, 'nothing saved');
  assert.equal(S.w.vault.entries.get('account/tobecancelled'), undefined);
  const free = await until(async () => { const r = await startAdd(S, 'second'); return r.status === 202 ? r : null; }, 8000, 150);
  assert.ok(free, 'a new sign-in can start after a cancel');
  await stopAdd(S);
  // cancel with nothing running is harmless
  const idle = await S.api('POST', '/api/accounts/add/cancel', { body: {} });
  assert.ok(idle.status < 500, `idle cancel -> ${idle.status}`);
});

test('a sign-in that fails (child exits without a login) saves nothing and shows a plain-words error, no secret', async (t) => {
  const S = await up(t, { stub: { url: GOOD_URL, delayMs: 100, oauth: null } });
  assert.equal((await startAdd(S, 'broken')).status, 202);
  const j = await until(async () => { const x = await S.get(); return x.signIn?.error ? x : null; }, 10000, 120);
  assert.ok(j, 'an error is reported');
  assert.equal(typeof j.signIn.error, 'string');
  assert.doesNotMatch(JSON.stringify(j), SECRETS);
  assert.equal(S.byName(j, 'broken'), undefined, 'nothing saved');
  assert.equal(S.w.vault.entries.get('account/broken'), undefined);
});

for (const bad of [
  'http://claude.ai/oauth/authorize',
  'https://claude.ai.evil.example/oauth/authorize',
  'https://evilclaude.ai/oauth/authorize',
  'https://claude.ai@evil.example/oauth/authorize',
  'https://evil.example/?next=https://claude.ai/login',
  'https://anthropic.com.evil.example/login',
  'javascript:alert(1)',
  'file:///etc/passwd',
]) {
  test(`a sign-in URL that is not https on anthropic.com / claude.ai / claude.com is never returned: ${bad}`, async (t) => {
    const S = await up(t, { stub: { url: bad, hang: true } });
    assert.equal((await startAdd(S, 'urltest')).status, 202);
    await until(async () => S.calls().some((c) => c.login), 8000, 80);
    await sleep(500);
    const j = await S.get();
    assert.ok(j.signIn, 'the sign-in is still running');
    assert.equal(j.signIn.url ?? null, null);
    assert.doesNotMatch(S.everything(), /evil\.example|evilclaude|javascript:|file:\/\//);
    await stopAdd(S);
  });
}

for (const good of ['https://claude.ai/oauth/authorize?x=1', 'https://claude.com/cai/oauth/authorize?x=1', 'https://anthropic.com/oauth/authorize?x=1']) {
  test(`an allowed sign-in URL is returned as it came: ${good}`, async (t) => {
    const S = await up(t, { stub: { url: good, hang: true } });
    assert.equal((await startAdd(S, 'urlok')).status, 202);
    const j = await until(async () => { const x = await S.get(); return x.signIn?.url ? x : null; }, 8000, 100);
    assert.ok(j, 'url shows up');
    assert.equal(j.signIn.url, good);
    await stopAdd(S);
  });
}
