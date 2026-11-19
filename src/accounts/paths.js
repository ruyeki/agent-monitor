// Default locations for the Claude accounts feature, and the guard that keeps tests away from the real ~/.claude and vault.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROD_PREFIX = 'agent-monitor/claude/';
export const TEST_PREFIX = /^agent-monitor-test-[a-z0-9]+\/$/;

const realClaude = () => path.resolve(os.homedir(), '.claude');
const testing = (env) => Boolean(process.env.NODE_TEST_CONTEXT || env?.NODE_TEST_CONTEXT);
const norm = (p) => {
  let r = path.resolve(p);
  try { r = fs.realpathSync.native(r); } catch { /* not there yet */ }
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

// True when p is the real ~/.claude or inside it, or the real ~/.claude.json.
export function isRealClaude(p) {
  const a = norm(p);
  const b = norm(realClaude());
  return a === b || a.startsWith(b + path.sep) || a === norm(path.join(os.homedir(), '.claude.json'));
}

// Under node --test, a path in the real ~/.claude is refused.
export function guardReal(p, env) {
  if (testing(env) && isRealClaude(p)) throw new Error('refusing the real ~/.claude under node --test');
  return p;
}

// Under node --test, only a test prefix is allowed; otherwise production or a test prefix.
export function guardPrefix(prefix, env) {
  if (prefix === PROD_PREFIX) {
    if (testing(env)) throw new Error('refusing the production vault prefix under node --test');
  } else if (typeof prefix !== 'string' || !TEST_PREFIX.test(prefix)) throw new Error('invalid vault prefix');
  return prefix;
}

// {dataDir, home, claudeJson, vaultPrefix} from the environment. home is the Claude config dir that holds .credentials.json;
// claudeJson is Claude Code's .claude.json (read only), which sits in the home root for the default profile.
export function defaults(env = process.env) {
  const home = env.AGENT_MONITOR_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || realClaude();
  const claudeJson = path.join(env.AGENT_MONITOR_CLAUDE_HOME || env.CLAUDE_CONFIG_DIR || os.homedir(), '.claude.json');
  const dataDir = env.AGENT_MONITOR_HOME || path.join(realClaude(), 'agent-monitor');
  const vaultPrefix = env.AGENT_MONITOR_VAULT_PREFIX || PROD_PREFIX;
  guardReal(home, env);
  guardReal(claudeJson, env);
  guardReal(dataDir, env);
  guardPrefix(vaultPrefix, env);
  return { dataDir, home, claudeJson, vaultPrefix };
}
