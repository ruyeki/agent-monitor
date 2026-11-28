// AC1 sign-in + AC5 refresh: done by Claude Code itself in a temp config dir, via a stub claude.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, cred, writeCred, readCred, readCredText, rejects, readUsageFile, filesWithTokens, readRegistry, NOW } from './holdout-accounts-helpers.js';

const dummyEnv = { CLAUDE_CODE_OAUTH_TOKEN: 'AMVTOK-env-oauth', ANTHROPIC_API_KEY: 'AMVTOK-env-key' };
const withEnv = async (fn) => {
  const saved = {}; for (const k of Object.keys(dummyEnv)) { saved[k] = process.env[k]; process.env[k] = dummyEnv[k]; }
  try { return await fn(); } finally { for (const k of Object.keys(dummyEnv)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
};

test('refresh(): runs claude headless in a temp config dir with an expired access token, saves the rotated login, cleans up', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana', stubEnv: { STUB_ROTATE: '1', STUB_ROT_TAG: 'R1', STUB_UTIL: '0.5' } });
  const homeBefore = readCredText(w.home);
  await withEnv(() => w.mgr.refresh('bob'));
  const [call] = w.stubCalls();
  assert.ok(call, 'claude was run');
  assert.ok(call.argv.includes('-p'));
  const i = call.argv.indexOf('--output-format'); assert.equal(call.argv[i + 1], 'stream-json');
  assert.ok(call.argv.includes('--strict-mcp-config'));
  assert.ok(call.argv.includes('--max-turns'));
  assert.equal(call.expiresAtSeen, 0, 'the saved login is presented as expired so Claude Code refreshes it');
  assert.ok(call.env.CLAUDE_CONFIG_DIR && path.resolve(call.env.CLAUDE_CONFIG_DIR) !== path.resolve(w.home), 'a temp config dir, not the real home');
  assert.equal(call.env.hasOauthEnv, false, 'CLAUDE_CODE_OAUTH_TOKEN stripped');
  assert.equal(call.env.hasApiKey, false, 'ANTHROPIC_API_KEY stripped');
  assert.ok(!fs.existsSync(call.env.CLAUDE_CONFIG_DIR), 'temp dir removed');
  assert.equal(readCredText(w.home), homeBefore, 'the live login was not touched');
  // the rotated refresh token reached the vault
  await w.mgr.use('bob');
  assert.equal(readCred(w.home).claudeAiOauth.refreshToken, 'AMVTOK-rt-rot-R1');
  // and the rate_limit_event it printed was recorded for bob
  const u = readUsageFile(w.dataDir, 'bob');
  assert.ok(Math.abs(u.reading.five_hour.used_percentage - 50) < 0.01);
  assert.deepEqual(filesWithTokens(w.dataDir), []);
});

test('refresh() never runs for the ACTIVE account', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana', stubEnv: { STUB_ROTATE: '1' } });
  await rejects(() => w.mgr.refresh('ana'));
  assert.equal(w.stubCalls().length, 0);
});

test('refresh() that comes back as a different account (or fails) does not overwrite the saved login', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana', stubEnv: { STUB_ROTATE: '1', STUB_ROT_TAG: 'BAD', STUB_UUID: 'uuid-someone-else' } });
  await rejects(() => w.mgr.refresh('bob'));
  const call = w.stubCalls()[0];
  if (call) assert.ok(!fs.existsSync(call.env.CLAUDE_CONFIG_DIR), 'temp dir removed even on failure');
  // a login that comes back as another account is a dead one: marked unsaved (not used), never overwritten
  await assert.rejects(() => w.mgr.use('bob'), /no saved login/);
  assert.equal(JSON.parse(await w.vault.get('account/bob')).refreshToken, cred('bob').claudeAiOauth.refreshToken, 'original saved login kept');
});

test('refresh() when claude is missing or crashes fails cleanly and leaves no temp dir', async (t) => {
  const { spawn: realSpawn } = await import('node:child_process');
  const seen = [];
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana', claudeSpawn: (cmd, args, opts) => { seen.push(opts?.env?.CLAUDE_CONFIG_DIR); return realSpawn(process.execPath, ['-e', 'process.exit(3)'], opts); } });
  await rejects(() => w.mgr.refresh('bob'));
  for (const d of seen.filter(Boolean)) assert.ok(!fs.existsSync(d), 'temp dir removed');
  await w.mgr.use('bob');
  assert.equal(readCred(w.home).claudeAiOauth.refreshToken, cred('bob').claudeAiOauth.refreshToken);
});

test('add(name) without current: signs in through `claude auth login --claudeai` in a temp config dir and registers the account', async (t) => {
  const w = await world(t, { accounts: ['ana'], active: 'ana', stubEnv: { STUB_LOGIN_ACCOUNT: 'orders' } });
  const homeBefore = readCredText(w.home);
  await w.mgr.add('orders', { email: 'orders@example.test' });
  const [call] = w.stubCalls();
  assert.deepEqual(call.argv.slice(0, 3), ['auth', 'login', '--claudeai']);
  assert.ok(call.argv.includes('--email'));
  assert.equal(call.argv[call.argv.indexOf('--email') + 1], 'orders@example.test');
  assert.notEqual(path.resolve(call.env.CLAUDE_CONFIG_DIR), path.resolve(w.home));
  assert.ok(!fs.existsSync(call.env.CLAUDE_CONFIG_DIR), 'temp dir removed');
  assert.equal(readCredText(w.home), homeBefore, 'the live login is untouched by a sign-in');
  const reg = readRegistry(w.dataDir);
  assert.equal(reg.accounts.orders.accountUuid, 'uuid-orders');
  assert.deepEqual(filesWithTokens(w.dataDir), []);
  await w.mgr.use('orders');
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-orders');
});

test('add(name) fails when the sign-in produces no login, registering nothing', async (t) => {
  const { spawn: realSpawn } = await import('node:child_process');
  const w = await world(t, { accounts: ['ana'], active: 'ana', claudeSpawn: (c, a, o) => realSpawn(process.execPath, ['-e', 'process.exit(0)'], o) });
  assert.ok(await rejects(() => w.mgr.add('ghost', {})));
  assert.deepEqual(Object.keys(readRegistry(w.dataDir).accounts), ['ana']);
});
