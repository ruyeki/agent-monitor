// Vault prefix guard, paths.defaults, resolveClaude/resolveExe.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, tmp, newPrefix, vaultWipe, vaultTargets } from './holdout-accounts-helpers.js';

const refused = async (fn) => { try { await fn(); return false; } catch { return true; } };

test('vault: bad prefixes are refused', async () => {
  const { createVault } = await load('src/accounts/vault.js');
  for (const p of ['', 'foo/', 'agent-monitor-test-/', 'agent-monitor-test-AB/', 'agent-monitor-test-ab', 'agent-monitor-test-a_b/', 'agent-monitor-test-ab/x/', '../agent-monitor-test-ab/', 'agent-monitor/other/', undefined, null, 5]) {
    assert.ok(await refused(async () => { const v = createVault({ prefix: p }); await v.get?.('account/x'); }), `prefix ${JSON.stringify(p)} must be refused`);
  }
});

test('vault: the production prefix is refused while running under the test runner', async () => {
  const { createVault } = await load('src/accounts/vault.js');
  const saved = process.env.NODE_TEST_CONTEXT; process.env.NODE_TEST_CONTEXT ??= 'child-v8';
  try {
    assert.ok(await refused(async () => { const v = createVault({ prefix: 'agent-monitor/claude/' }); await v.get?.('account/x'); await v.list?.(); }));
  } finally { if (saved === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT = saved; }
});

test('vault: a valid test prefix is accepted and creating a vault touches nothing', async () => {
  const { createVault } = await load('src/accounts/vault.js');
  const prefix = newPrefix();
  try { assert.doesNotThrow(() => createVault({ prefix })); assert.deepEqual(vaultTargets(prefix), []); } finally { vaultWipe(prefix); }
});

test('paths.defaults: env overrides and the standard locations', async () => {
  const { defaults } = await load('src/accounts/paths.js');
  // the standard locations are checked outside the test runner (under it the real ~/.claude is refused on purpose)
  const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; for (const k of ['AGENT_MONITOR_HOME', 'AGENT_MONITOR_CLAUDE_HOME', 'CLAUDE_CONFIG_DIR', 'AGENT_MONITOR_VAULT_PREFIX']) delete env[k];
  const { spawnSync } = await import('node:child_process'); const { fileUrl } = await import('./holdout-accounts-helpers.js');
  const r = spawnSync(process.execPath, ['-e', `import(${JSON.stringify(fileUrl('src/accounts/paths.js'))}).then((m) => console.log(JSON.stringify(m.defaults({}))))`], { env, encoding: 'utf8' });
  const d = JSON.parse(r.stdout);
  assert.equal(path.resolve(d.dataDir), path.resolve(path.join(os.homedir(), '.claude', 'agent-monitor')));
  assert.equal(path.resolve(d.home), path.resolve(path.join(os.homedir(), '.claude')));
  assert.equal(d.vaultPrefix, 'agent-monitor/claude/');
  assert.throws(() => defaults({ AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-ab12/' }), 'under the test runner the real ~/.claude is refused');
  const a = defaults({ AGENT_MONITOR_HOME: 'C:\\x\\data', CLAUDE_CONFIG_DIR: 'C:\\x\\cfg', AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-ab12/' });
  assert.equal(path.resolve(a.dataDir), path.resolve('C:\\x\\data'));
  assert.equal(path.resolve(a.home), path.resolve('C:\\x\\cfg'));
  const b = defaults({ AGENT_MONITOR_HOME: 'C:\\x\\d2', AGENT_MONITOR_CLAUDE_HOME: 'C:\\x\\mine', CLAUDE_CONFIG_DIR: 'C:\\x\\cfg', AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-ab12/' });
  assert.equal(path.resolve(b.home), path.resolve('C:\\x\\mine'), 'AGENT_MONITOR_CLAUDE_HOME wins over CLAUDE_CONFIG_DIR');
  assert.equal(b.vaultPrefix, 'agent-monitor-test-ab12/');
});

test('resolveClaude: absolute path as is; claude.exe found on PATH; never a relative PATH entry or the cwd', async () => {
  const { resolveClaude } = await load('src/exe.js');
  const dir = tmp('amv-exe-'); fs.writeFileSync(path.join(dir, 'claude.exe'), '');
  const pathKey = process.platform === 'win32' ? 'Path' : 'PATH';
  assert.equal(resolveClaude('C:\\no\\such\\claude.exe', {}), 'C:\\no\\such\\claude.exe');
  assert.equal(resolveClaude('claude', { [pathKey]: dir }), path.join(dir, 'claude.exe'));
  assert.equal(resolveClaude('claude', { [pathKey]: 'relative\\dir;.' }), null);
  assert.equal(resolveClaude('claude', {}), null);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveClaude: the npm shim (claude.cmd) resolves to the real claude.exe beside it, never the .cmd', async (t) => {
  if (process.platform !== 'win32') return t.skip('windows only');
  const { resolveClaude } = await load('src/exe.js');
  const dir = tmp('amv-shim-'); fs.writeFileSync(path.join(dir, 'claude.cmd'), '');
  const bin = path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code', 'bin'); fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(path.join(bin, 'claude.exe'), '');
  assert.equal(resolveClaude('claude', { Path: dir }), path.join(bin, 'claude.exe'));
  fs.rmSync(path.join(bin, 'claude.exe'));
  assert.equal(resolveClaude('claude', { Path: dir }), null, 'a shim with no exe behind it resolves to nothing');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('resolveExe still finds codex.exe on PATH only (moved from codex.js)', async () => {
  const { resolveExe } = await load('src/exe.js');
  const dir = tmp('amv-exe2-'); fs.writeFileSync(path.join(dir, 'codex.exe'), '');
  assert.equal(resolveExe('codex', { Path: dir, PATH: dir }), path.join(dir, 'codex.exe'));
  assert.equal(resolveExe('codex', { Path: '.', PATH: '.' }), null);
  fs.rmSync(dir, { recursive: true, force: true });
});
