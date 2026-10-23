import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startServer } from '../src/server.js';
import { seedWorkflow } from '../src/workflow.js';
import { tmp, advance, jsonHeaders } from './helpers.js';

const BIN = path.join(import.meta.dirname, '..', 'bin', 'agent-monitor.js');

async function boot(extra = {}) {
  const s = await startServer({ port: 0, dataDir: tmp(), projectsDir: tmp(), webDir: path.join(tmp(), 'missing'), ...extra });
  return s;
}
const call = async (s, method, p, body, headers = {}) => {
  const res = await fetch(s.url + p, { method, headers: body === undefined ? headers : { ...jsonHeaders, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const raw = (s, { method = 'GET', p = '/api/runs', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port: s.port, method, path: p, headers }, (res) => {
    let data = '';
    res.on('error', reject);
    res.on('data', (c) => { data += c; });
    res.on('end', () => resolve({ status: res.statusCode, data }));
  });
  req.on('error', reject);
  req.end(body);
});

test('REST: run list, detail, respond, stop and 404s', async () => {
  const s = await boot();
  try {
    s.store.startRun({ title: 'First run', task: 'do it', repo: 'r', branch: 'b' });
    advance(s.store, 'first-run', 'gate1');
    const list = (await call(s, 'GET', '/api/runs')).body;
    assert.equal(list.length, 1);
    assert.deepEqual(Object.keys(list[0]).sort(), ['actions', 'ask', 'branch', 'createdAt', 'endedAt', 'id', 'maxRounds', 'note', 'repo', 'round', 'stage', 'stageName', 'status', 'task', 'textField', 'title', 'updatedAt', 'verdict', 'workflowVersion'].sort());
    assert.deepEqual([list[0].status, list[0].textField, list[0].actions], ['waiting', true, [{ label: 'Agree spec' }, { label: 'Stop run' }]]);

    const d = (await call(s, 'GET', '/api/runs/first-run')).body;
    assert.deepEqual(Object.keys(d).sort(), ['activity', 'agents', 'run', 'timeline', 'workflow']);
    assert.equal(d.workflow.stages.length, 11);
    assert.ok(d.timeline.length >= 2);

    const bad = await call(s, 'POST', '/api/runs/first-run/respond', { action: 'Maybe' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Agree spec/);
    const ok = await call(s, 'POST', '/api/runs/first-run/respond', { action: 'agree spec', text: 'yes' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.stage, 'plan');
    assert.equal((await call(s, 'POST', '/api/runs/first-run/stop', {})).body.status, 'stopped');
    assert.equal((await call(s, 'POST', '/api/runs/first-run/stop', {})).status, 400);

    assert.equal((await call(s, 'GET', '/api/runs/none')).status, 404);
    assert.equal((await call(s, 'POST', '/api/runs/none/respond', { action: 'x' })).status, 404);
    assert.equal((await call(s, 'GET', '/api/nope')).status, 404);
    assert.equal((await call(s, 'POST', '/api/runs/first-run/respond', undefined, jsonHeaders)).status, 400);
  } finally { await s.close(); }
});

test('REST: workflow draft, publish, versions, load, reset', async () => {
  const s = await boot();
  try {
    const w = (await call(s, 'GET', '/api/workflow')).body;
    assert.equal(w.published.version, 1);
    assert.deepEqual(w.draft.errors, []);
    assert.equal(w.draft.baseVersion, 1);

    const broken = seedWorkflow();
    broken.stages = broken.stages.filter((x) => x.id !== 'verify');
    const saved = await call(s, 'PUT', '/api/workflow/draft', { workflow: broken });
    assert.equal(saved.status, 200);
    assert.ok(saved.body.errors.length > 0);
    const pub = await call(s, 'POST', '/api/workflow/publish', {});
    assert.equal(pub.status, 400);
    assert.ok(pub.body.errors.length > 0);
    assert.equal((await call(s, 'PUT', '/api/workflow/draft', { workflow: 5 })).status, 400);

    const fixed = seedWorkflow();
    fixed.stages[2].name = 'Plan it';
    await call(s, 'PUT', '/api/workflow/draft', { workflow: fixed });
    assert.deepEqual((await call(s, 'POST', '/api/workflow/publish', {})).body, { version: 2 });
    const versions = (await call(s, 'GET', '/api/workflow/versions')).body;
    assert.deepEqual(versions.map((v) => v.version), [2, 1]);
    assert.equal((await call(s, 'GET', '/api/workflow/versions/1')).body.workflow.stages[2].name, 'Plan');
    assert.equal((await call(s, 'GET', '/api/workflow/versions/9')).status, 404);
    const loaded = (await call(s, 'POST', '/api/workflow/versions/1/load', {})).body;
    assert.equal(loaded.workflow.stages[2].name, 'Plan');
    assert.equal((await call(s, 'POST', '/api/workflow/versions/9/load', {})).status, 404);
    const reset = (await call(s, 'DELETE', '/api/workflow/draft', {})).body;
    assert.equal(reset.workflow.stages[2].name, 'Plan it');
  } finally { await s.close(); }
});

test('security: Host and Origin checks (403), Content-Type check (415), body cap (413)', async () => {
  const s = await boot();
  try {
    assert.equal((await raw(s, { headers: { Host: 'evil.example:80' } })).status, 403);
    assert.equal((await raw(s, { headers: { Host: `localhost:${s.port}` } })).status, 200);
    assert.equal((await raw(s, { headers: { Origin: 'http://evil.example' } })).status, 403);
    assert.equal((await raw(s, { headers: { Origin: `http://localhost:${s.port}` } })).status, 200);
    assert.equal((await raw(s, { headers: { Origin: `http://127.0.0.1:${s.port}` } })).status, 200);
    assert.equal((await raw(s, { headers: { Origin: `http://127.0.0.1:${s.port + 1}` } })).status, 403);
    for (const [method, p] of [['POST', '/api/runs/x/stop'], ['PUT', '/api/workflow/draft'], ['DELETE', '/api/workflow/draft'], ['POST', '/api/workflow/publish']]) {
      const r = await raw(s, { method, p, headers: { 'Content-Type': 'text/plain' }, body: '{}' });
      assert.equal(r.status, 415, `${method} ${p}`);
      assert.equal((await raw(s, { method, p })).status, 415);
    }
    const big = await raw(s, { method: 'PUT', p: '/api/workflow/draft', headers: jsonHeaders, body: `{"workflow":"${'x'.repeat(5 * 1024 * 1024)}"}` }).catch(() => ({ status: 413 }));
    assert.equal(big.status, 413);
  } finally { await s.close(); }
});

test('wait: long-polls until the run is answered, times out, 404s', async () => {
  const s = await boot();
  try {
    s.store.startRun({ title: 'W' });
    advance(s.store, 'w', 'gate1');
    assert.deepEqual((await call(s, 'GET', '/api/runs/w/wait?timeout=150')).body, { done: false });
    const pending = call(s, 'GET', '/api/runs/w/wait?timeout=5000');
    await new Promise((r) => setTimeout(r, 100));
    await call(s, 'POST', '/api/runs/w/respond', { action: 'Agree spec', text: 'go' });
    const done = (await pending).body;
    assert.deepEqual([done.done, done.action, done.text, done.stage, done.status], [true, 'Agree spec', 'go', 'plan', 'active']);
    assert.equal(done.run.id, 'w');
    assert.equal((await call(s, 'GET', '/api/runs/w/wait?timeout=5000')).body.done, true); // not waiting: immediate
    assert.equal((await call(s, 'GET', '/api/runs/zzz/wait')).status, 404);
  } finally { await s.close(); }
});

test('SSE: events stream announces run changes', async () => {
  const s = await boot();
  try {
    const seen = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: s.port, path: '/api/events' }, (res) => {
        assert.match(res.headers['content-type'], /text\/event-stream/);
        let buf = '';
        res.on('data', (c) => {
          buf += c;
          if (buf.includes('data: ')) { res.destroy(); resolve(buf); }
          if (buf.includes(': connected') && !buf.includes('data: ') && !res.fired) { res.fired = true; s.store.startRun({ title: 'Sse' }); }
        });
        res.on('error', () => {});
      }).on('error', reject);
    });
    assert.deepEqual(JSON.parse(seen.split('data: ')[1].split('\n')[0]), { type: 'run', runId: 'sse' });
  } finally { await s.close(); }
});

test('static files: placeholder when not built, files served, traversal blocked', async () => {
  const webDir = tmp('am-web');
  fs.writeFileSync(path.join(webDir, 'index.html'), '<h1>ui</h1>');
  fs.writeFileSync(path.join(webDir, 'app.js'), 'x');
  fs.writeFileSync(path.join(path.dirname(webDir), 'secret.txt'), 'SECRET');
  const none = await boot();
  const built = await boot({ webDir });
  try {
    assert.match((await raw(none, { p: '/' })).data, /npm run build/);
    assert.equal((await raw(built, { p: '/' })).data, '<h1>ui</h1>');
    assert.equal((await raw(built, { p: '/app.js' })).data, 'x');
    assert.equal((await raw(built, { p: '/some/route' })).data, '<h1>ui</h1>');
    for (const p of ['/..%2fsecret.txt', '/%2e%2e/secret.txt', '/../secret.txt']) {
      const r = await raw(built, { p });
      assert.ok(!r.data.includes('SECRET'), p);
    }
  } finally { await none.close(); await built.close(); }
});

test('/hook: answers {} for junk, links runs, denies stopped-run subagents; GET is refused', async () => {
  const s = await boot();
  try {
    assert.deepEqual((await call(s, 'POST', '/hook', { hook_event_name: 'Nope' })).body, {});
    const bad = await raw(s, { method: 'POST', p: '/hook', headers: jsonHeaders, body: '{not json' });
    assert.deepEqual([bad.status, bad.data], [200, '{}']);
    assert.equal((await raw(s, { p: '/hook' })).status, 405);

    s.store.startRun({ title: 'H' });
    const base = { session_id: 'sess', transcript_path: path.join(tmp(), 'x.jsonl'), cwd: '/c' };
    await call(s, 'POST', '/hook', { ...base, hook_event_name: 'PostToolUse', tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: 'h' }, tool_response: 'x', tool_use_id: 'a' });
    await call(s, 'POST', '/hook', { ...base, hook_event_name: 'SubagentStart', agent_id: 'ag1', agent_type: 'worker' });
    s.store.stopRun('h');
    const deny = await call(s, 'POST', '/hook', { ...base, hook_event_name: 'PreToolUse', agent_id: 'ag1', tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'b' });
    assert.equal(deny.body.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(deny.body.hookSpecificOutput.permissionDecisionReason, /run h was stopped by Ryan/);
    assert.deepEqual((await call(s, 'GET', '/api/runs/h')).body.agents.map((a) => a.id).sort(), ['ag1', 'main:sess']);
  } finally { await s.close(); }
});

test('MCP: tools through the SDK client', async () => {
  const s = await boot();
  const client = new Client({ name: 'test', version: '1' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${s.url}/mcp`)));
    const text = async (name, args = {}) => {
      const r = await client.callTool({ name, arguments: args });
      return { text: r.content[0].text, isError: !!r.isError };
    };
    const tools = (await client.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(tools, ['complete_stage', 'get_run', 'get_workflow', 'list_runs', 'log', 'respond', 'start_run']);

    const start = await text('start_run', { title: 'Mcp run', task: 't', repo: 'r' });
    assert.match(start.text, /^RUN mcp-run · stage frame \(Frame\) · round 0\/5 · status active\nNEXT: frame \(Frame\) — runner main, model inherit\nINSTRUCTIONS: .*complete_stage/);

    const wrong = await text('complete_stage', { run: 'mcp-run', stage: 'verify', outcome: 'pass' });
    assert.equal(wrong.isError, true);
    assert.match(wrong.text, /^ERROR: Run is at stage 'frame', not 'verify'/);

    const gate = await text('complete_stage', { run: 'mcp-run', stage: 'frame', outcome: 'pass', note: 'spec ready' });
    assert.match(gate.text, /^RUN mcp-run · stage gate1 \(Gate 1: solution\) · round 0\/5 · status waiting\nWAITING ON RYAN: What's your solution\?\nACTIONS: Agree spec \| Stop run \(text allowed\)\nRun in the background: node ".*agent-monitor\.js" wait mcp-run/);

    assert.match((await text('complete_stage', { run: 'mcp-run', stage: 'gate1', outcome: 'pass' })).text, /use respond/);
    assert.match((await text('respond', { run: 'mcp-run', action: 'Nope' })).text, /^ERROR: Unknown action/);
    const plan = await text('respond', { run: 'mcp-run', action: 'agree spec', text: 'ok' });
    assert.match(plan.text, /stage plan \(Plan\).*\nNEXT: plan \(Plan\) — runner lead, model opus/);

    assert.match((await text('log', { run: 'mcp-run', note: 'halfway' })).text, /^RUN mcp-run/);
    assert.match((await text('get_run', { run: 'mcp-run' })).text, /^RUN mcp-run · stage plan/);
    assert.equal((await text('get_run', { run: 'zzz' })).isError, true);
    assert.match((await text('list_runs')).text, /^mcp-run · plan · active · Mcp run$/);
    assert.match((await text('get_workflow')).text, /^WORKFLOW v1\n1\. frame \(Frame\)/);
    assert.match((await text('get_workflow', { run: 'mcp-run' })).text, /^WORKFLOW v1/);
    assert.equal((await text('start_run', { title: '' })).isError, true);
    assert.ok((await call(s, 'GET', '/api/runs/mcp-run')).body.timeline.some((e) => e.note === 'halfway'));
  } finally { await client.close(); await s.close(); }
});

test('/mcp refuses GET, bad Host and wrong Content-Type', async () => {
  const s = await boot();
  try {
    assert.equal((await raw(s, { p: '/mcp' })).status, 405);
    assert.equal((await raw(s, { method: 'POST', p: '/mcp', headers: { ...jsonHeaders, Host: 'evil:1' }, body: '{}' })).status, 403);
    assert.equal((await raw(s, { method: 'POST', p: '/mcp', headers: { 'Content-Type': 'text/plain' }, body: '{}' })).status, 415);
  } finally { await s.close(); }
});

test('data survives a server restart', async () => {
  const dataDir = tmp();
  let s = await boot({ dataDir });
  s.store.startRun({ title: 'Keep me' });
  await s.close();
  s = await boot({ dataDir });
  try {
    assert.deepEqual((await call(s, 'GET', '/api/runs')).body.map((r) => r.id), ['keep-me']);
  } finally { await s.close(); }
});

test('the installed curl hook command fails open: exit 0, no output, under 1 s when nothing listens', async () => {
  const probe = await boot();
  const { port } = probe;
  await probe.close();
  const cmd = `curl -s --connect-timeout 0.1 -m 1 -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${port}/hook || true`;
  const t0 = Date.now();
  const r = spawnSync('bash', ['-c', cmd], { input: '{"hook_event_name":"Stop"}', encoding: 'utf8' });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, '');
  assert.ok(Date.now() - t0 < 1000, `took ${Date.now() - t0} ms`);
});

test('the curl hook command talks to a live server and prints {}', async () => {
  const s = await boot();
  try {
    const cmd = `curl -s --connect-timeout 0.1 -m 1 -H 'Content-Type: application/json' --data-binary @- ${s.url}/hook || true`;
    const child = spawn('bash', ['-c', cmd]); // async: the server runs in this process
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stdin.end('{"hook_event_name":"Stop","session_id":"q"}');
    await new Promise((r) => child.on('exit', r));
    assert.equal(out, '{}');
  } finally { await s.close(); }
});

function runCli(args, env) {
  const child = spawn(process.execPath, [BIN, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  const out = { stdout: '', stderr: '', code: null, exited: new Promise((r) => child.on('exit', (c) => { out.code = c; r(c); })) };
  child.stdout.on('data', (d) => { out.stdout += d; });
  child.stderr.on('data', (d) => { out.stderr += d; });
  out.kill = () => child.kill();
  return out;
}

test('CLI wait: retries while the server is down, then prints the answer as one JSON line', async () => {
  const dataDir = tmp();
  const first = await boot({ dataDir });
  const { port } = first;
  first.store.startRun({ title: 'Cli' });
  advance(first.store, 'cli', 'gate1');
  await first.close();

  const cli = runCli(['wait', 'cli'], { AGENT_MONITOR_URL: `http://127.0.0.1:${port}` });
  try {
    await new Promise((r) => setTimeout(r, 700));
    assert.equal(cli.code, null); // still retrying, silently
    assert.equal(cli.stderr, '');
    const s = await startServer({ port, dataDir, projectsDir: tmp(), webDir: tmp() });
    try {
      await new Promise((r) => setTimeout(r, 2800)); // one retry later it is polling the live server
      assert.equal(cli.code, null);
      await call(s, 'POST', '/api/runs/cli/respond', { action: 'Agree spec', text: 'go ahead' });
      assert.equal(await Promise.race([cli.exited, new Promise((r) => setTimeout(() => r('timeout'), 10000))]), 0);
      assert.deepEqual(JSON.parse(cli.stdout.trim()), { run: 'cli', action: 'Agree spec', text: 'go ahead', stage: 'plan', status: 'active' });
      assert.equal(cli.stdout.trim().split('\n').length, 1);
    } finally { await s.close(); }
  } finally { cli.kill(); }
});

test('CLI wait: unknown run exits 1 with a message; no arguments prints usage', async () => {
  const s = await boot();
  try {
    const cli = runCli(['wait', 'ghost'], { AGENT_MONITOR_URL: s.url });
    assert.equal(await cli.exited, 1);
    assert.match(cli.stderr, /no run 'ghost'/);
    const usage = runCli([], {});
    assert.equal(await usage.exited, 2);
  } finally { await s.close(); }
});
