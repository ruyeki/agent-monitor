import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { refreshLogin } from '../src/accounts/refresh.js';
import { loadRegistry, readUsage } from '../src/accounts/state.js';
import { until } from './codex-helpers.js';
import { world, oauth, credsText, tmp, readLog, STUB, NOW, DAY } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const LAB = oauth('uuid-lab', { refreshTokenExpiresAt: NOW + 3 * DAY });
const ORDERS = oauth('uuid-orders', { refreshTokenExpiresAt: NOW + 20 * DAY });
const INFO = { status: 'allowed', resetsAt: 1795059600, rateLimitType: 'five_hour', unifiedWindows: { five_hour: { utilization: 0.15, resetsAt: 1795059600 }, seven_day: { utilization: 0.37, resetsAt: 1795284000 } } };
const REFRESH_ARGS = ['-p', '--model', 'haiku', '--output-format', 'stream-json', '--verbose', '--max-turns', '1', '--strict-mcp-config'];

// A world whose claude is the stub; stub behaviour from cfg, its calls in log.
function stubWorld(t, cfg = {}, opts = {}) {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const env = { ...process.env, AM_LOGIN_LOG: log, AM_LOGIN_STUB: JSON.stringify(cfg), CLAUDE_CODE_OAUTH_TOKEN: 'FAKE-env-token', ANTHROPIC_API_KEY: 'FAKE-env-key', ANTHROPIC_AUTH_TOKEN: 'FAKE-env-auth' };
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB, orders: ORDERS }, live: RYAN, claude: { command: process.execPath, args: [STUB] }, env, ...opts });
  return { ...w, log, calls: () => readLog(log) };
}

test('refresh: runs Claude Code in a temp config dir with expiresAt 0, saves the rotated login, records the rate limit', async (t) => {
  const w = stubWorld(t, { rateLimit: INFO });
  const r = await w.m.refresh('lab');
  assert.equal(r.name, 'lab');
  const [call] = w.calls();
  assert.deepEqual(call.argv, REFRESH_ARGS);
  assert.equal(call.cwd.toLowerCase(), call.configDir.toLowerCase(), 'cwd is the temp dir');
  assert.notEqual(call.configDir.toLowerCase(), w.home.toLowerCase());
  assert.equal(call.seen.expiresAt, 0, 'expiresAt forced to 0');
  assert.equal(call.seen.refreshToken, LAB.refreshToken);
  assert.equal(call.hasOauthToken, false);
  assert.equal(call.hasAuthToken, false);
  assert.match(call.stdin, /OK/);
  assert.equal(fs.existsSync(call.configDir), false, 'temp dir removed');

  const saved = JSON.parse(w.vault.entries.get('account/lab'));
  assert.equal(saved.refreshToken, `${LAB.refreshToken}-rotated`);
  assert.ok(saved.expiresAt > 0);
  assert.equal(loadRegistry(w.dataDir).accounts.lab.savedAt, new Date(NOW).toISOString());
  assert.deepEqual(readUsage(w.dataDir, 'lab').reading.five_hour, { used_percentage: 15, resets_at: 1795059600 });
  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(RYAN), 'other accounts untouched');
});

test('refresh: a limited account still saves its rotated token and records the limit', async (t) => {
  const w = stubWorld(t, { exit: 1, rateLimit: { ...INFO, status: 'rejected' } });
  await w.m.refresh('lab');
  assert.equal(JSON.parse(w.vault.entries.get('account/lab')).refreshToken, `${LAB.refreshToken}-rotated`);
  assert.equal(readUsage(w.dataDir, 'lab').limit.resetsAt, 1795059600);
});

test('refresh: the active account is refused; failures keep the saved login and remove the temp dir', async (t) => {
  const w = stubWorld(t, { exit: 1, write: 'none' });
  await assert.rejects(w.m.refresh('ryan'), /live login/);
  assert.equal(w.calls().length, 0, 'Claude Code never ran for the live account');

  const before = w.vault.entries.get('account/lab');
  await assert.rejects(w.m.refresh('lab'), /did not refresh the login \(exit 1\)/);
  assert.equal(w.vault.entries.get('account/lab'), before);
  assert.equal(fs.existsSync(w.calls()[0].configDir), false);

  const other = stubWorld(t, { write: 'other' });
  await assert.rejects(other.m.refresh('lab'), /did not return a login for this account/);
  assert.equal(other.vault.entries.get('account/lab'), JSON.stringify(LAB));
  assert.equal(fs.existsSync(other.calls()[0].configDir), false);
  await assert.rejects(other.m.refresh('nobody'), /no account named/);
});

test('refreshLogin: a hung Claude Code is killed at the timeout and the temp dir is removed', async (t) => {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const env = { ...process.env, AM_LOGIN_LOG: log, AM_LOGIN_STUB: JSON.stringify({ write: 'none', hang: true }) };
  await assert.rejects(refreshLogin(LAB, { claude: { command: process.execPath, args: [STUB] }, env, timeoutMs: 1500 }), /timed out/);
  const [call] = readLog(log);
  assert.equal(fs.existsSync(call.configDir), false);
  await assert.rejects(refreshLogin(LAB, { claude: null }), /not found/);
});

test('refreshDue: only non-active accounts whose refresh token expires within 7 days', async (t) => {
  const w = stubWorld(t, {}, { live: LAB });
  const due = await w.m.refreshDue();
  assert.deepEqual(due, [], 'lab is live, orders has 20 days, ryan 30');
  const w2 = stubWorld(t, {});
  assert.deepEqual(await w2.m.refreshDue(), [{ name: 'lab', ok: true }]);
  assert.equal(w2.calls().length, 1);
});

test('add: signs in through `claude auth login` in a temp config dir and saves the new login', async (t) => {
  const NEW = oauth('uuid-new');
  const w = stubWorld(t, { oauth: NEW, email: 'new@example.com' });
  const r = await w.m.add('newbie', { email: 'new@example.com' });
  assert.deepEqual(r, { name: 'newbie', email: 'new@example.com', accountUuid: 'uuid-new' });
  const [call] = w.calls();
  assert.deepEqual(call.argv, ['auth', 'login', '--claudeai', '--email', 'new@example.com']);
  assert.equal(call.hasOauthToken, false);
  assert.equal(call.hasAuthToken, false);
  assert.equal(fs.existsSync(call.configDir), false);
  assert.equal(w.vault.entries.get('account/newbie'), JSON.stringify(NEW));

  const w2 = stubWorld(t, { oauth: oauth('uuid-two'), email: 'two@example.com' });
  assert.equal((await w2.m.add('two')).email, 'two@example.com', 'email read from the profile Claude Code wrote');
  assert.deepEqual(w2.calls()[0].argv, ['auth', 'login', '--claudeai']);

  const w3 = stubWorld(t, { write: 'none', exit: 1 });
  await assert.rejects(w3.m.add('three'), /sign-in did not finish \(exit 1\)/);
  assert.equal(fs.existsSync(w3.calls()[0].configDir), false);
  assert.equal(loadRegistry(w3.dataDir).accounts.three, undefined);
  const w4 = stubWorld(t, { oauth: RYAN });
  await assert.rejects(w4.m.add('again'), /already saved as "ryan"/);
});

test('sync-back: a changed live login is saved to its account; an unchanged one is not written again', async (t) => {
  const w = stubWorld(t);
  let writes = 0;
  const set = w.vault.set;
  w.vault.set = async (k, v) => { writes++; return set(k, v); };
  assert.equal(await w.m.syncBack(), true, 'first sight is saved');
  assert.equal(await w.m.syncBack(), false);
  assert.equal(writes, 1);
  const rotated = { ...RYAN, accessToken: 'sk-ant-oat01-FAKE-live-rotated', refreshToken: 'sk-ant-ort01-FAKE-live-rotated' };
  fs.writeFileSync(w.file, credsText(rotated));
  assert.equal(await w.m.syncBack(), true);
  assert.equal(w.vault.entries.get('account/ryan'), JSON.stringify(rotated));
  fs.writeFileSync(w.file, credsText(oauth('uuid-unknown')));
  assert.equal(await w.m.syncBack(), false, 'an unregistered login is not saved');

  w.m.startSync({ intervalMs: 100 });
  const again = { ...rotated, refreshToken: 'sk-ant-ort01-FAKE-watched' };
  fs.writeFileSync(w.file, credsText(again));
  assert.ok(await until(() => w.vault.entries.get('account/ryan') === JSON.stringify(again), 5000), 'the watcher/poll saved it');
  w.m.close();
});
