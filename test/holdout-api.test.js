import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { boot, mcpClient, req, until, runIdOf, load } from './holdout-helpers.js';

const W = await load('src/workflow.js');
let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const seed = () => structuredClone(W.seedWorkflow());

// ---- AC6 workflow REST
test('AC6 first boot: published v1 equals seed, draft equals v1, no errors', async () => {
  const r = await S.api('GET', '/api/workflow');
  assert.equal(r.status, 200);
  assert.equal(r.json.published.version, 1);
  assert.deepEqual(r.json.published.workflow.nodes.map((s) => s.id), seed().nodes.map((s) => s.id));
  assert.deepEqual(r.json.draft.workflow, r.json.published.workflow);
  assert.equal(r.json.draft.baseVersion, 1);
  assert.deepEqual(r.json.draft.errors, []);
  assert.ok(r.json.published.publishedAt);
});

test('AC6 PUT draft saves an invalid draft and reports its errors; publish then refuses with 400 errors', async () => {
  const bad = seed(); bad.nodes.find((s) => s.id === 'plan').runner = 'robot';
  const put = await S.api('PUT', '/api/workflow/draft', { body: { workflow: bad } });
  assert.equal(put.status, 200);
  assert.ok(put.json.errors.length >= 1);
  const got = await S.api('GET', '/api/workflow');
  assert.equal(got.json.draft.workflow.nodes.find((s) => s.id === 'plan').runner, 'robot');
  assert.ok(got.json.draft.errors.length >= 1);
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 400);
  assert.ok(Array.isArray(pub.json.errors) && pub.json.errors.length >= 1);
  assert.equal((await S.api('GET', '/api/workflow')).json.published.version, 1, 'nothing was published');
  const versions = await S.api('GET', '/api/workflow/versions');
  assert.equal(versions.json.length, 1);
});

test('AC6 DELETE draft resets it to the latest published', async () => {
  const del = await S.api('DELETE', '/api/workflow/draft');
  assert.equal(del.status, 200);
  const got = await S.api('GET', '/api/workflow');
  assert.deepEqual(got.json.draft.workflow, got.json.published.workflow);
  assert.deepEqual(got.json.draft.errors, []);
});

test('AC6 publish a valid draft makes v2; versions list; load a version back into the draft', async () => {
  const v2 = seed();
  v2.nodes.find((s) => s.id === 'plan').instructions = 'Plan it, v2 text.';
  v2.loop.maxRounds = 3;
  assert.equal((await S.api('PUT', '/api/workflow/draft', { body: { workflow: v2 } })).status, 200);
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 200);
  assert.equal(pub.json.version, 2);
  const cur = await S.api('GET', '/api/workflow');
  assert.equal(cur.json.published.version, 2);
  assert.equal(cur.json.published.workflow.loop.maxRounds, 3);
  const list = await S.api('GET', '/api/workflow/versions');
  assert.deepEqual(list.json.map((v) => v.version).sort(), [1, 2]);
  assert.ok(list.json.every((v) => v.publishedAt && v.nodes === seed().nodes.length));
  const one = await S.api('GET', '/api/workflow/versions/1');
  assert.equal(one.json.version, 1);
  assert.equal(one.json.workflow.loop.maxRounds, 5);
  assert.equal((await S.api('GET', '/api/workflow/versions/99')).status, 404);
  const load1 = await S.api('POST', '/api/workflow/versions/1/load');
  assert.equal(load1.status, 200);
  const after1 = await S.api('GET', '/api/workflow');
  assert.equal(after1.json.draft.workflow.loop.maxRounds, 5);
  assert.equal(after1.json.published.version, 2, 'loading does not publish');
});

test('AC6 publishing an unchanged draft does not hand back garbage; version numbers only grow', async () => {
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.ok([200, 400].includes(pub.status));
  if (pub.status === 200) assert.ok(pub.json.version >= 2);
});

// ---- AC5: publish does not change in-flight runs
test('AC5 in-flight run keeps its pinned version after a publish; new runs get the newest', async () => {
  const a = await M.call('start_run', { title: 'Pin test A' });
  const idA = runIdOf(a.text);
  const before = (await S.api('GET', `/api/runs/${idA}`)).json;
  const pinned = before.run.workflowVersion;
  const marker = seed();
  marker.nodes.find((s) => s.id === 'implement').instructions = 'MARKER-NEWEST-VERSION';
  marker.nodes.push({ id: 'extra', name: 'Extra', type: 'step', runner: 'main', model: 'inherit', instructions: 'x', pushes: false });
  // keep push guard valid: extra after pr is fine
  marker.edges.find((e) => e.from === 'pr').to = 'extra';
  marker.edges.push({ id: 'extra>done:done', from: 'extra', to: 'done', on: 'done' });
  await S.api('PUT', '/api/workflow/draft', { body: { workflow: marker } });
  const pub = await S.api('POST', '/api/workflow/publish');
  assert.equal(pub.status, 200);
  const afterRun = (await S.api('GET', `/api/runs/${idA}`)).json;
  assert.equal(afterRun.run.workflowVersion, pinned);
  assert.ok(!JSON.stringify(afterRun.workflow).includes('MARKER-NEWEST-VERSION'));
  assert.ok(!afterRun.workflow.nodes.some((s) => s.id === 'extra'));
  const gw = await M.call('get_workflow', { run: idA });
  assert.ok(!gw.text.includes('extra'));
  const gwNew = await M.call('get_workflow', {});
  assert.ok(gwNew.text.includes('extra'));
  const b = await M.call('start_run', { title: 'Pin test B' });
  const idB = runIdOf(b.text);
  const runB = (await S.api('GET', `/api/runs/${idB}`)).json;
  assert.equal(runB.run.workflowVersion, pub.json.version);
  assert.ok(JSON.stringify(runB.workflow).includes('MARKER-NEWEST-VERSION'));
  // in-flight run still progresses on its pinned workflow
  const r = await M.call('complete_stage', { run: idA, stage: 'frame', outcome: 'pass' });
  assert.equal(r.isError, false);
  assert.match(r.text, /WAITING ON RYAN/);
});

// ---- runs REST
test('REST run summary, detail, respond, stop, wait', async () => {
  const s = await M.call('start_run', { title: 'REST flow', task: 'do things', repo: 'r', branch: 'b' });
  const id = runIdOf(s.text);
  const list = await S.api('GET', '/api/runs');
  assert.equal(list.status, 200);
  const sum = list.json.find((r) => r.id === id);
  for (const k of ['id', 'title', 'task', 'active', 'repo', 'branch', 'workflowVersion', 'stage', 'stageName', 'round', 'maxRounds', 'status', 'verdict', 'ask', 'actions', 'textField', 'note', 'createdAt', 'updatedAt', 'endedAt']) assert.ok(k in sum, 'summary has ' + k);
  assert.equal(sum.stage, 'frame');
  assert.equal(sum.title, 'REST flow');
  assert.equal(sum.maxRounds, 5);

  // wait on a non-waiting run returns immediately with done:true
  const t0 = Date.now();
  const immediate = await S.api('GET', `/api/runs/${id}/wait?timeout=5000`);
  assert.equal(immediate.json.done, true);
  assert.ok(Date.now() - t0 < 2000);

  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  const waiting = (await S.api('GET', `/api/runs/${id}`)).json;
  assert.equal(waiting.run.status, 'waiting');
  assert.equal(waiting.run.ask, "What's your solution?");
  assert.deepEqual(waiting.run.actions.map((a) => a.label), ['Agree spec', 'Stop run']);
  assert.equal(waiting.run.textField, true);
  for (const k of ['workflow', 'timeline', 'agents', 'activity']) assert.ok(k in waiting, k);
  assert.ok(waiting.timeline.length >= 1);

  const timeout = await S.api('GET', `/api/runs/${id}/wait?timeout=300`);
  assert.deepEqual(timeout.json, { done: false });

  const pending = S.api('GET', `/api/runs/${id}/wait?timeout=10000`);
  await new Promise((r) => setTimeout(r, 200));
  const bad = await S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'Nope', text: '' } });
  assert.equal(bad.status, 400);
  assert.ok(bad.json.error.includes('Agree spec'));
  const ok = await S.api('POST', `/api/runs/${id}/respond`, { body: { action: 'agree spec', text: 'do X' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.stage, 'plan');
  assert.equal(ok.json.status, 'active');
  const w = await pending;
  assert.equal(w.json.done, true);
  assert.equal(w.json.text, 'do X');
  assert.match(w.json.action, /agree spec/i);
  assert.equal(w.json.stage, 'plan');
  assert.equal(w.json.status, 'active');
  assert.ok(w.json.run);

  const stop = await S.api('POST', `/api/runs/${id}/stop`, { body: {} });
  assert.equal(stop.status, 200);
  assert.equal(stop.json.status, 'stopped');
  assert.ok(stop.json.endedAt);
  assert.equal((await S.api('GET', '/api/runs/nope-nope/wait?timeout=100')).status, 404);
  assert.equal((await S.api('GET', '/api/runs/nope-nope')).status, 404);
  assert.equal((await S.api('POST', '/api/runs/nope-nope/respond', { body: { action: 'x' } })).status, 404);
});

test('REST runs list is newest-updated first', async () => {
  const a = runIdOf((await M.call('start_run', { title: 'Order A' })).text);
  await new Promise((r) => setTimeout(r, 1100));
  const b = runIdOf((await M.call('start_run', { title: 'Order B' })).text);
  let ids = (await S.api('GET', '/api/runs')).json.map((r) => r.id);
  assert.ok(ids.indexOf(b) < ids.indexOf(a));
  await new Promise((r) => setTimeout(r, 1100));
  await M.call('log', { run: a, note: 'touch' });
  ids = (await S.api('GET', '/api/runs')).json.map((r) => r.id);
  assert.ok(ids.indexOf(a) < ids.indexOf(b));
});

test('REST wait timeout is clamped to 60000 and garbage timeout does not crash', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Clamp' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  const r = await S.api('GET', `/api/runs/${id}/wait?timeout=abc`);
  assert.ok(r.status === 200 || r.status === 400);
  const t0 = Date.now();
  await S.api('GET', `/api/runs/${id}/wait?timeout=-5`);
  assert.ok(Date.now() - t0 < 5000);
});

test('SSE /api/events streams run changes', async () => {
  const got = await new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: S.port, path: '/api/events', method: 'GET' }, (res) => {
      assert.match(res.headers['content-type'] || '', /text\/event-stream/);
      let buf = '';
      res.on('data', (c) => {
        buf += c.toString();
        if (/"type"\s*:\s*"run"/.test(buf)) { r.destroy(); resolve(buf); }
      });
    });
    r.on('error', (e) => { if (e.code !== 'ECONNRESET') reject(e); });
    r.end();
    setTimeout(() => M.call('start_run', { title: 'SSE run' }), 300);
    setTimeout(() => { r.destroy(); reject(new Error('no SSE run event within 6s')); }, 6000);
  });
  const line = got.split('\n').find((l) => l.startsWith('data:'));
  assert.ok(JSON.parse(line.slice(5)).type);
});

test('static: missing web/dist serves the build hint at /', async () => {
  const r = await S.api('GET', '/');
  assert.equal(r.status, 200);
  assert.match(r.text, /npm run build/);
});

test('static: path traversal out of webDir is refused', async () => {
  for (const p of ['/../package.json', '/..%2f..%2fpackage.json', '/%2e%2e/%2e%2e/etc/passwd', '/..\\..\\package.json']) {
    const r = await S.api('GET', p);
    assert.ok(!/"name"\s*:\s*"agent-monitor"/.test(r.text), p);
    assert.ok(!/root:/.test(r.text), p);
  }
});

// ---- security constraints
test('SEC Host header must be 127.0.0.1:<port> or localhost:<port>', async () => {
  for (const host of ['evil.example.com', 'evil.example.com:' + S.port, '127.0.0.1', `127.0.0.1.evil.com:${S.port}`, '0.0.0.0:' + S.port]) {
    const r = await S.api('GET', '/api/runs', { headers: { Host: host } });
    assert.equal(r.status, 403, 'Host ' + host);
  }
  for (const host of [`127.0.0.1:${S.port}`, `localhost:${S.port}`]) {
    const r = await S.api('GET', '/api/runs', { headers: { Host: host } });
    assert.equal(r.status, 200, 'Host ' + host);
  }
});

test('SEC Origin header must be local when present', async () => {
  for (const origin of ['http://evil.example.com', 'https://127.0.0.1:' + S.port, 'http://127.0.0.1:1', 'null', `http://127.0.0.1.evil.com:${S.port}`]) {
    const g = await S.api('GET', '/api/runs', { headers: { Origin: origin } });
    assert.equal(g.status, 403, 'GET Origin ' + origin);
    const p = await S.api('POST', '/api/workflow/publish', { headers: { Origin: origin } , body: {} });
    assert.equal(p.status, 403, 'POST Origin ' + origin);
  }
  for (const origin of [`http://127.0.0.1:${S.port}`, `http://localhost:${S.port}`]) {
    assert.equal((await S.api('GET', '/api/runs', { headers: { Origin: origin } })).status, 200, origin);
  }
});

test('SEC mutating requests need Content-Type application/json (415)', async () => {
  const wf = JSON.stringify({ workflow: seed() });
  for (const [m, p] of [['PUT', '/api/workflow/draft'], ['POST', '/api/workflow/publish'], ['POST', '/api/runs/whatever/respond'], ['POST', '/api/runs/whatever/stop'], ['DELETE', '/api/workflow/draft']]) {
    for (const ct of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', null]) {
      const r = await S.api(m, p, { rawBody: m === 'DELETE' ? undefined : wf, headers: { 'Content-Type': ct } });
      assert.equal(r.status, 415, `${m} ${p} with ${ct}`);
    }
  }
  const ok = await S.api('PUT', '/api/workflow/draft', { rawBody: wf, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
  assert.equal(ok.status, 200);
});

test('SEC a 6 MB body is refused (cap 5 MB) and the server survives', async () => {
  const big = JSON.stringify({ workflow: { stages: [], pad: 'x'.repeat(6 * 1024 * 1024) } });
  let status;
  try { status = (await S.api('PUT', '/api/workflow/draft', { rawBody: big })).status; } catch { status = 'reset'; }
  assert.ok(status === 'reset' || (status >= 400 && status < 500), 'got ' + status);
  assert.equal((await S.api('GET', '/api/runs')).status, 200);
});

test('SEC malformed JSON bodies are 4xx, not 5xx', async () => {
  const r = await S.api('PUT', '/api/workflow/draft', { rawBody: '{nope', headers: { 'Content-Type': 'application/json' } });
  assert.ok(r.status >= 400 && r.status < 500, 'status ' + r.status);
  assert.ok(r.json?.error);
});

test('SEC /mcp and /hook also reject foreign Host and Origin', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
  const headers = { Accept: 'application/json, text/event-stream' };
  const mcpEvil = await S.api('POST', '/mcp', { body, headers: { ...headers, Host: 'evil.example.com' } });
  assert.equal(mcpEvil.status, 403);
  const mcpOrigin = await S.api('POST', '/mcp', { body, headers: { ...headers, Origin: 'http://evil.example.com' } });
  assert.equal(mcpOrigin.status, 403);
  const hookEvil = await S.api('POST', '/hook', { body: { hook_event_name: 'Stop' }, headers: { Host: 'evil.example.com' } });
  assert.equal(hookEvil.status, 403);
  const hookOrigin = await S.api('POST', '/hook', { body: { hook_event_name: 'Stop' }, headers: { Origin: 'http://evil.example.com' } });
  assert.equal(hookOrigin.status, 403);
});

test('SEC server listens on 127.0.0.1 only', async () => {
  assert.match(S.url, /^http:\/\/127\.0\.0\.1:\d+/);
});
