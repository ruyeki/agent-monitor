// Baseline: what the touched account code does today (logins that DO carry accountUuid).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as creds from '../src/accounts/creds.js';
import { refreshLogin, signIn } from '../src/accounts/refresh.js';
import { recordWindows } from '../src/accounts/record.js';
import { readUsage } from '../src/accounts/state.js';
import { defaults, guardReal } from '../src/accounts/paths.js';
import { vworld, full, tmp, NOW, DAY } from './holdout-accounts-signin-helpers.js';

const STUBF = path.join(import.meta.dirname, 'fixtures', 'claude-login-stub.mjs');
const claude = { command: process.execPath, args: [STUBF] };
const envOf = (cfg) => ({ ...process.env, AM_LOGIN_STUB: JSON.stringify(cfg) });
const A = full('u-a');
const B = full('u-b');

test('base validOauth needs tokens and accountUuid; liveOauth returns the raw object', (t) => {
  assert.equal(creds.validOauth(A), true);
  assert.equal(creds.validOauth({ ...A, accountUuid: undefined }), false);
  const w = vworld(t, { live: A });
  assert.deepEqual(creds.liveOauth(w.home), A);
  assert.equal(creds.liveOauth(tmp(t)), null);
});

test('base signIn: login with accountUuid works and reads the email from .claude.json', async () => {
  const r = await signIn({ claude, env: envOf({ oauth: A, email: 'a@example.com' }) });
  assert.equal(r.oauth.accountUuid, 'u-a');
  assert.equal(r.email, 'a@example.com');
});

test('base signIn: no login written -> "sign-in did not finish"', async () => {
  await assert.rejects(() => signIn({ claude, env: envOf({ write: 'none' }) }), /sign-in did not finish/);
});

test('base refreshLogin: rotates, keeps the account; another account is refused', async () => {
  const { oauth } = await refreshLogin(A, { claude, env: envOf({}) });
  assert.equal(oauth.refreshToken, `${A.refreshToken}-rotated`);
  assert.equal(oauth.accountUuid, 'u-a');
  await assert.rejects(() => refreshLogin(A, { claude, env: envOf({ write: 'other' }) }), /did not return a login for this account/);
});

test('base add --current saves the live login; the same login under another name is refused', async (t) => {
  const w = vworld(t, { live: A });
  const r = await w.m.add('a', { current: true });
  assert.equal(r.accountUuid, 'u-a');
  assert.equal(w.vaultOf('a').accountUuid, 'u-a');
  await assert.rejects(() => w.m.add('a2', { current: true }), /already saved as "a"/);
});

test('base swap: saves the rotated live login back, then switches', async (t) => {
  const rot = { ...B, refreshToken: 'sk-ant-ort01-FAKE-rot' };
  const w = vworld(t, { accounts: { a: A, b: B }, live: rot });
  assert.equal(w.m.activeName(), 'b');
  const r = await w.m.use('a');
  assert.deepEqual({ from: r.from, to: r.to, switched: r.switched }, { from: 'b', to: 'a', switched: true });
  assert.equal(w.vaultOf('b').refreshToken, 'sk-ant-ort01-FAKE-rot');
  assert.equal(JSON.parse(w.live()).claudeAiOauth.accountUuid, 'u-a');
  assert.ok(w.vault.entries.has('backup'));
});

test('base swap: a live login nobody saved is refused', async (t) => {
  const w = vworld(t, { accounts: { a: A }, live: full('u-c') });
  await assert.rejects(() => w.m.use('a'), /not a saved account/);
});

test('base syncBack saves a rotated live login; unchanged one saves nothing', async (t) => {
  const rot = { ...B, refreshToken: 'sk-ant-ort01-FAKE-rot2' };
  const w = vworld(t, { accounts: { a: A, b: B }, live: rot });
  assert.equal(await w.m.syncBack(), true);
  assert.equal(w.vaultOf('b').refreshToken, 'sk-ant-ort01-FAKE-rot2');
  assert.equal(await w.m.syncBack(), false);
});

test('base recordWindows attributes to the live account by accountUuid', (t) => {
  const w = vworld(t, { accounts: { a: A, b: B }, live: B });
  const reading = { five_hour: { used_percentage: 10, resets_at: Math.floor((NOW + 3 * 3600e3) / 1000) } };
  assert.equal(recordWindows({ dataDir: w.dataDir, home: w.home, reading, now: NOW }), 'b');
  assert.equal(readUsage(w.dataDir, 'b').reading.five_hour.used_percentage, 10);
});

test('base handleLimit on the active account switches to the other', async (t) => {
  const w = vworld(t, { accounts: { a: A, b: B }, live: A });
  const r = await w.m.handleLimit({ at: new Date(NOW).toISOString(), resetsAt: Math.floor((NOW + 3600e3) / 1000), source: 'stopfailure' });
  assert.equal(r.next, 'b');
  assert.equal(r.switched, true);
});

test('base defaults()/guardReal: real ~/.claude refused under node --test, temp home fine', (t) => {
  const d = tmp(t);
  assert.equal(defaults({ AGENT_MONITOR_CLAUDE_HOME: d, AGENT_MONITOR_HOME: d, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-abc/' }).home, d);
  assert.throws(() => defaults({}), /refusing/);
  assert.doesNotThrow(() => guardReal(d));
  void DAY; void fs;
});
