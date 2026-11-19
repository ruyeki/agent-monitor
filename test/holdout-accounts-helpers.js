// Shared helpers for the account-rotation holdouts. Not a test file. Never prints token values. Works wherever it is placed inside the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { spawnSync, spawn as realSpawn } from 'node:child_process';

function findRepo() {
  let d = import.meta.dirname;
  for (let i = 0; i < 8; i++, d = path.dirname(d)) {
    try { if (JSON.parse(fs.readFileSync(path.join(d, 'package.json'), 'utf8')).name === 'agent-monitor') return d; } catch { /* up */ }
  }
  throw new Error('repo root not found');
}
export const REPO = findRepo().replaceAll('\\', '/');
export const fileUrl = (rel) => pathToFileURL(path.join(REPO, rel)).href;
export const load = (rel) => import(fileUrl(rel));
export const LIB = import.meta.dirname;
export const CLAUDE_STUB = path.join(LIB, 'fixtures', 'accounts-claude-stub.mjs');
export const CODEX_STUB = path.join(LIB, 'fixtures', 'accounts-codex-stub.mjs');
export const tmp = (p = 'amv-') => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), p)));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const NOW = Date.parse('2026-11-18T10:00:00Z');
export const sec = (ms) => Math.floor(ms / 1000);
export const iso = (ms) => new Date(ms).toISOString();
export const H = 3600e3;

export async function until(fn, ms = 15000, step = 50) {
  const end = Date.now() + ms; let last;
  while (Date.now() < end) { try { last = await fn(); if (last) return last; } catch { /* retry */ } await sleep(step); }
  return last;
}
// name of a pickBest/list-style result (string or {name})
export const nm = (x) => (x == null ? null : typeof x === 'string' ? x : x.name ?? null);
export const names = (xs) => (Array.isArray(xs) ? xs : Object.keys(xs ?? {})).map((x) => (typeof x === 'string' ? x : x.name));

// ---- fake credentials (compact JSON, real-world key order) ----
export const TOKEN_MARK = 'AMVTOK';
export function cred(name, { mcp, extra = {}, refreshExp = NOW + 60 * 24 * H, big = false } = {}) {
  const pad = big ? 'x'.repeat(5000) : '';
  return {
    mcpOAuth: mcp ?? { srv: { accessToken: `${TOKEN_MARK}-mcp-shared` } },
    claudeAiOauth: {
      accessToken: `${TOKEN_MARK}-at-${name}${pad}`, refreshToken: `${TOKEN_MARK}-rt-${name}`, expiresAt: NOW + 8 * H,
      refreshTokenExpiresAt: refreshExp, scopes: ['user:inference', 'user:profile'], subscriptionType: 'team',
      subscriptionTypeSource: 'x', rateLimitTier: 'default_claude_max_5x', accountUuid: `uuid-${name}`, organizationUuid: `org-${name}`, ...extra,
    },
    organizationUuid: `org-${name}`,
  };
}
export const credText = (c) => JSON.stringify(c);
export const writeCred = (home, c) => fs.writeFileSync(path.join(home, '.credentials.json'), typeof c === 'string' ? c : credText(c));
export const readCredText = (home) => fs.readFileSync(path.join(home, '.credentials.json'), 'utf8');
export const readCred = (home) => JSON.parse(readCredText(home));
export const credExists = (home) => fs.existsSync(path.join(home, '.credentials.json'));

// ---- vault cleanup through cmdkey (independent of the code under test) ----
export const newPrefix = () => `agent-monitor-test-${crypto.randomBytes(4).toString('hex')}/`;
export function vaultTargets(prefix) {
  const r = spawnSync('cmdkey', ['/list'], { encoding: 'utf8', windowsHide: true });
  const out = `${r.stdout ?? ''}`;
  const set = new Set();
  for (const m of out.matchAll(/Target:\s*(?:LegacyGeneric:target=|Domain:target=)?(\S+)/g)) if (m[1].startsWith(prefix)) set.add(m[1]);
  return [...set];
}
export function vaultWipe(prefix) {
  if (!/^agent-monitor-test-[a-z0-9]+\/$/.test(prefix)) throw new Error('refusing to wipe a non-test prefix');
  for (const t of vaultTargets(prefix)) spawnSync('cmdkey', [`/delete:${t}`], { windowsHide: true });
}

// ---- scanning for secrets on disk ----
export function filesUnder(dir) {
  const out = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else out.push(p); } };
  try { walk(dir); } catch { /* none */ }
  return out;
}
export const filesWithTokens = (dir, skip = []) => filesUnder(dir).filter((f) => !skip.includes(f) && fs.readFileSync(f).includes(TOKEN_MARK));

export const readJsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

// The module that exports createAccounts is the worker's choice: try the likely names.
export async function loadAccounts() {
  for (const f of ['index', 'manager', 'accounts', 'core']) {
    try { const m = await load(`src/accounts/${f}.js`); if (typeof m.createAccounts === 'function') return m; } catch { /* next */ }
  }
  throw new Error('createAccounts not found under src/accounts/');
}

// ---- a world: temp home + data dir + test vault + manager ----
export async function world(t, { clock: clockFn, claudeSpawn, stubEnv = {}, accounts = [], active } = {}) {
  const prefix = newPrefix();
  const home = tmp('amv-home-'); const dataDir = tmp('amv-data-'); const stubDir = tmp('amv-stub-');
  const state = { now: NOW };
  const clock = clockFn ?? (() => state.now);
  const { createVault } = await load('src/accounts/vault.js');
  const { createAccounts } = await loadAccounts();
  const vault = createVault({ prefix });
  const fakeClaude = path.join(stubDir, 'claude.exe');
  const spawn = claudeSpawn ?? ((cmd, args, opts) => realSpawn(process.execPath, [CLAUDE_STUB, stubDir, ...args], { ...opts, env: { ...(opts?.env ?? process.env), ...stubEnv } }));
  const mgr = createAccounts({ dataDir, home, vault, claude: fakeClaude, spawn, clock });
  const w = { prefix, home, dataDir, stubDir, state, mgr, vault, clock, spawn, fakeClaude, stubCalls: () => readJsonl(path.join(stubDir, 'calls.jsonl')) };
  t.after(async () => {
    try { fs.chmodSync(path.join(home, '.credentials.json'), 0o666); } catch { /* none */ }
    try { mgr.close?.(); } catch { /* ignore */ }
    vaultWipe(prefix);
    for (const d of [home, dataDir, stubDir]) fs.rmSync(d, { recursive: true, force: true });
  });
  // register accounts by saving a temp login file as each, then leave `active` in place
  for (const a of accounts) { writeCred(home, cred(a)); await mgr.add(a, { current: true, email: `${a}@example.test` }); }
  if (active) writeCred(home, cred(active));
  else if (accounts.length) fs.rmSync(path.join(home, '.credentials.json'), { force: true });
  return w;
}
export const reading = (five, seven, { fiveReset = sec(NOW + 3 * H), sevenReset = sec(NOW + 48 * H) } = {}) => ({
  five_hour: five == null ? undefined : { used_percentage: five, resets_at: fiveReset },
  seven_day: seven == null ? undefined : { used_percentage: seven, resets_at: sevenReset }, at: NOW,
});
export async function rejects(fn) { try { const r = await fn(); return !!(r && (r.ok === false || r.error)); } catch { return true; } }
export const readRegistry = (dataDir) => JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts', 'registry.json'), 'utf8'));
export const readUsageFile = (dataDir, name) => JSON.parse(fs.readFileSync(path.join(dataDir, 'accounts', `usage-${name}.json`), 'utf8'));

// ---- http ----
export function req(port, method, p, { body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? JSON.stringify(body) : (method === 'GET' ? undefined : '{}');
    const h = data !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {};
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const c = []; res.on('data', (x) => c.push(x));
      res.on('end', () => { const text = Buffer.concat(c).toString('utf8'); let json; try { json = JSON.parse(text); } catch { /* no */ } resolve({ status: res.statusCode, text, json }); });
    });
    r.on('error', reject); if (data !== undefined) r.write(data); r.end();
  });
}
export async function mcpClient(url) {
  const { Client } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
  const { StreamableHTTPClientTransport } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'));
  const client = new Client({ name: 'verifier', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url.replace(/\/$/, '') + '/mcp')));
  const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return (r.content || []).map((c) => c.text).join('\n'); };
  return { client, call };
}
export const runIdOf = (text) => /^RUN (\S+)/.exec(text.split('\n')[0])?.[1];
export function makeRepo(parent, name) {
  const dir = path.join(parent, name); fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  spawnSync('git', ['init', '-q', dir], { windowsHide: true }); return dir;
}

// ---- a server (optionally with the accounts option) ----
export async function boot({ accountsOpt = null, codex = true, repos = ['repoA'] } = {}) {
  const { startServer } = await load('src/server.js');
  const dir = tmp('amv-srv-'); const root = tmp('amv-root-'); for (const r of repos) makeRepo(root, r);
  const projectsDir = tmp('amv-proj-');
  const opts = { port: 0, dataDir: tmp('amv-sdata-'), projectsDir, webDir: path.join(tmp('amv-web-'), 'nope'), usageIntervalMs: 300 };
  const codexDir = tmp('amv-cx-');
  if (codex) opts.codex = { command: process.execPath, args: [CODEX_STUB, codexDir], root };
  if (accountsOpt) opts.accounts = { command: process.execPath, args: [CLAUDE_STUB, dir], ...accountsOpt };
  const srv = await startServer(opts);
  const mcp = await mcpClient(srv.url);
  const call = (n, a) => mcp.call(n, a);
  const post = (payload) => req(srv.port, 'POST', '/hook', { body: payload });
  const startRun = async (title, extra = {}) => runIdOf(await call('start_run', { title, ...extra }));
  // The session's transcript sits under projectsDir and names the folder: a resume takes its folder only from there.
  const link = (session, run) => {
    const transcript = path.join(projectsDir, 'p', `${session}.jsonl`);
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(transcript, `${JSON.stringify({ cwd: root })}\n`);
    return post({ hook_event_name: 'PostToolUse', session_id: session, cwd: root, transcript_path: transcript, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run }, tool_response: {}, tool_use_id: `l-${session}` });
  };
  const limit = (session, extra = {}) => post({ hook_event_name: 'StopFailure', session_id: session, cwd: root, error: 'rate_limit', error_details: { resetsAt: sec(Date.now() + 3 * H) }, last_assistant_message: 'limit', ...extra });
  const detail = async (id) => (await req(srv.port, 'GET', `/api/runs/${id}`)).json;
  return {
    srv, call, post, startRun, link, limit, detail, root, dir, codexCalls: () => readJsonl(path.join(codexDir, 'calls.jsonl')), claudeCalls: () => readJsonl(path.join(dir, 'calls.jsonl')),
    close: async () => { try { await mcp.client.close(); } catch { /* ignore */ } await srv.close(); },
  };
}
