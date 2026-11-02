// Shared helpers for the Codex-fallback holdouts. Not a test file. Works wherever it is placed inside the repo.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

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
export const tmp = (p = 'amx-') => fs.mkdtempSync(path.join(os.tmpdir(), p));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const STUB = path.join(import.meta.dirname, 'fixtures', 'codex-stub-h.mjs');

export async function until(fn, ms = 20000, step = 40) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}

export function req(port, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let data;
    if (body !== undefined) { data = JSON.stringify(body); h['Content-Type'] ??= 'application/json'; }
    else if (!['GET', 'HEAD'].includes(method)) { data = '{}'; h['Content-Type'] ??= 'application/json'; }
    if (data !== undefined) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, text, json });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

export async function mcpClient(url) {
  const { Client } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
  const { StreamableHTTPClientTransport } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'));
  const client = new Client({ name: 'holdout', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url.replace(/\/$/, '') + '/mcp')));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: (r.content || []).map((c) => c.text).join('\n') };
  };
  return { client, call };
}

export const runIdOf = (text) => /^RUN (\S+)/.exec(text.split('\n')[0])?.[1];
export const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
export const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason ?? '';
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// A git work tree (or a plain dir with { git: false }) at <parent>/<name>.
export function makeRepo(parent, name, { git = true } = {}) {
  const dir = path.join(parent, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  if (git) spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
  return dir;
}

// The stub's per-call script: { calls: [{events:[obj|string], delayMs, sleepMs, exit, hang, grandchild}], default: {...} }
export function writeScript(dir, script) { fs.writeFileSync(path.join(dir, 'script.json'), JSON.stringify(script)); }
export function readCalls(dir) {
  try { return fs.readFileSync(path.join(dir, 'calls.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}
export const LIMIT_MSG = "You've hit your usage limit. Upgrade to Pro or try again at 9:41 PM.";
export const started = (id = 'T1') => ({ type: 'thread.started', thread_id: id });
export const completed = (usage = { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 10 }) => ({ type: 'turn.completed', usage });

// A server with the Codex launcher pointed at the stub. codex:false boots without the option.
export async function bootCodex({ script = { default: { events: [started('T1')] } }, codex = true, repos = [], usageIntervalMs = 300 } = {}) {
  const { startServer } = await load('src/server.js');
  const dir = tmp('amx-stub-');
  const root = fs.realpathSync(tmp('amx-root-'));
  for (const r of repos) makeRepo(root, r);
  writeScript(dir, script);
  const home = tmp('amx-home-'); const projects = tmp('amx-proj-');
  const opts = { port: 0, dataDir: home, projectsDir: projects, webDir: path.join(tmp('amx-web-'), 'nope'), usageIntervalMs };
  if (codex) opts.codex = { command: process.execPath, args: [STUB, dir], root };
  const srv = await startServer(opts);
  const api = (m, p, o) => req(srv.port, m, p, o);
  const mcp = await mcpClient(srv.url);
  const call = async (n, a) => (await mcp.call(n, a)).text;
  const post = (payload, p = '/hook') => req(srv.port, 'POST', p, { body: payload });
  const startRun = async (title = 'Run', extra = {}) => runIdOf(await call('start_run', { title, ...extra }));
  // The Claude session gets linked to the run the way the real hook does it.
  const link = (session, run, extra = {}) => post({ hook_event_name: 'PostToolUse', session_id: session, cwd: root, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run }, tool_response: {}, tool_use_id: `l-${session}`, ...extra });
  const limit = (session, extra = {}) => post({ hook_event_name: 'StopFailure', session_id: session, cwd: root, error: 'rate_limit', error_details: { resetsAt: 1791655200 }, last_assistant_message: 'limit', ...extra });
  const detail = async (id) => (await api('GET', `/api/runs/${id}`)).json;
  const calls = () => readCalls(dir);
  const close = async () => { try { await mcp.client.close(); } catch { /* ignore */ } await srv.close(); };
  return { srv, api, post, call, startRun, link, limit, detail, calls, dir, root, home, projects, close, port: srv.port, setScript: (s) => writeScript(dir, s) };
}

export function freePort() {
  return new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
}
