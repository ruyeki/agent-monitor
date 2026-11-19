import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createVault, memoryVault } from '../src/accounts/vault.js';
import { PROD_PREFIX, defaults } from '../src/accounts/paths.js';
import os from 'node:os';
import path from 'node:path';

const SECRET = 'sk-ant-ort01-FAKE-secret-value';
const testPrefix = () => `agent-monitor-test-${Math.random().toString(36).slice(2, 10).replace(/[^a-z0-9]/g, '') || 'x'}/`;
const cmdkeyTargets = (prefix) => {
  let out = '';
  try { out = execFileSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true }); } catch { /* none */ }
  return out.split(/\r?\n/).filter((l) => l.includes(prefix));
};

test('vault: round trip in Windows Credential Manager with a test prefix, chunked values, cleanup', { skip: process.platform !== 'win32' }, async (t) => {
  const prefix = testPrefix();
  const v = createVault({ prefix });
  t.after(async () => {
    for (const k of await v.list().catch(() => [])) await v.delete(k).catch(() => {});
    assert.deepEqual(cmdkeyTargets(prefix), [], 'no test credentials left behind');
  });
  const big = `{"x":"${'é'.repeat(1500)}${'k'.repeat(1700)}"}`; // > 2560 bytes, multi-byte chars split across chunks
  assert.ok(Buffer.byteLength(big) > 2560);
  await v.setMany({ 'account/ryan': '{"a":1}', backup: big });
  assert.deepEqual(await v.getMany(['account/ryan', 'backup', 'account/none']), { 'account/ryan': '{"a":1}', backup: big, 'account/none': null });
  assert.deepEqual(await v.list(), ['account/ryan', 'backup'], 'chunk entries are not keys');
  assert.ok(cmdkeyTargets(prefix).length >= 4, 'the big value is stored in chunks');
  await v.set('backup', 'small now');
  assert.equal(await v.get('backup'), 'small now');
  assert.equal(cmdkeyTargets(prefix).length, 2, 'old chunks are pruned');
  await v.delete('account/ryan');
  await v.delete('backup');
  assert.equal(await v.get('account/ryan'), null);
  assert.deepEqual(await v.list(), []);
});

test('vault: the prefix guard refuses production under node --test and any non-test prefix', () => {
  assert.throws(() => createVault({ prefix: PROD_PREFIX }), /production vault prefix/);
  for (const p of ['agent-monitor/other/', 'agent-monitor-test-/', 'agent-monitor-test-ABC/', 'agent-monitor-test-x', '', undefined]) {
    assert.throws(() => createVault({ prefix: p }), /invalid vault prefix/, String(p));
  }
  assert.ok(createVault({ prefix: 'agent-monitor-test-ok1/', run: async () => ({}) }));
});

test('paths: defaults refuse the real ~/.claude and the production prefix under node --test', () => {
  const real = path.join(os.homedir(), '.claude');
  const temp = os.tmpdir();
  assert.throws(() => defaults({ AGENT_MONITOR_HOME: temp, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-a/' }), /real ~\/\.claude/);
  assert.throws(() => defaults({ AGENT_MONITOR_HOME: temp, AGENT_MONITOR_CLAUDE_HOME: real, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-a/' }), /real ~\/\.claude/);
  assert.throws(() => defaults({ AGENT_MONITOR_CLAUDE_HOME: temp, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-a/' }), /real ~\/\.claude/, 'dataDir defaults inside ~/.claude');
  assert.throws(() => defaults({ AGENT_MONITOR_HOME: temp, AGENT_MONITOR_CLAUDE_HOME: temp }), /production vault prefix/);
  const env = { AGENT_MONITOR_HOME: temp, CLAUDE_CONFIG_DIR: temp, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-a/' };
  assert.deepEqual(defaults(env),
    { dataDir: temp, home: temp, claudeJson: path.join(env.AGENT_MONITOR_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json'), vaultPrefix: 'agent-monitor-test-a/' });
});

test('vault: errors carry no secret, stdout or stderr text', async () => {
  const ops = [];
  const cases = [
    async () => ({ code: 1, stdout: `garbage ${SECRET}` }),
    async () => ({ code: 1, stdout: `{"fatal":"Ex ${SECRET}"}` }),
    async () => ({ code: 0, stdout: JSON.stringify({ results: [{ error: `CredWriteW ${SECRET}`, code: 5 }, { ok: true }] }) }),
    async () => { throw new Error('vault: PowerShell timed out'); },
  ];
  for (const run of cases) {
    const v = createVault({ prefix: 'agent-monitor-test-err/', run: async (input) => { ops.push(input); return run(); } });
    await assert.rejects(v.set('account/ryan', SECRET), (e) => {
      assert.match(e.message, /^vault: /);
      const flat = e.message.replace(/[^a-z0-9]/gi, '');
      assert.ok(!flat.includes('FAKEsecretvalue') && !e.message.includes(Buffer.from(SECRET).toString('base64').slice(0, 20)), e.message);
      return true;
    });
  }
  assert.ok(ops.every((i) => !i.includes(SECRET)), 'the value goes base64-encoded on stdin');
  await assert.rejects(createVault({ prefix: 'agent-monitor-test-err/', run: async () => ({}) }).get('../x'), /invalid key/);
});

test('memoryVault: same API in memory', async () => {
  const v = memoryVault();
  await v.setMany({ a: '1', b: '2' });
  assert.deepEqual(await v.getMany(['a', 'c']), { a: '1', c: null });
  await v.delete('a');
  assert.deepEqual(await v.list(), ['b']);
});
