// White-hat probes for am-crew-ledger (Post-only recording + GET /api/runs/:id/activity).
// A failing test is a proven exposure; the "refute" tests pin attacks that are blocked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './holdout-helpers.js';

const FAKE = 'Zq9FakeSecretValue0000'; // not a real secret
const hook = (api, body) => api('POST', '/hook', { body });

async function setup() {
  const b = await boot();
  const { run } = b.srv.store.startRun({ title: 'R' });
  b.srv.store.linkSession('s1', run.id);
  const { run: other } = b.srv.store.startRun({ title: 'Other' });
  const post = (extra) => hook(b.api, { session_id: 's1', cwd: '/x', hook_event_name: 'PostToolUse', tool_response: { stdout: 'ok', stderr: '' }, ...extra });
  return { ...b, id: run.id, other: other.id, post };
}

// EXPOSURE (backlog #260, live again): with Post-only recording, a Bash command's text lands raw in activity.summary
// and agents.last_summary and is served by /activity and /api/runs/:id, while the Ledger copy of the same call is masked.
test('EXPOSURE: Post-only Bash secret is served raw by /activity (Ledger copy is masked)', async (t) => {
  const s = await setup();
  t.after(() => s.srv.close());
  await s.post({ agent_id: 'sub1', agent_type: 'w', tool_name: 'Bash', tool_use_id: 'u1', tool_input: { command: `PGPASSWORD=${FAKE} psql -h db -c "select 1"` } });
  const ledger = (await s.api('GET', `/api/runs/${s.id}/ledger`)).json;
  assert.ok(!JSON.stringify(ledger).includes(FAKE), 'ledger masks the secret');
  const act = (await s.api('GET', `/api/runs/${s.id}/activity?agent=sub1`)).json;
  const detail = (await s.api('GET', `/api/runs/${s.id}`)).json;
  assert.ok(!JSON.stringify(act).includes(FAKE), `activity endpoint serves the raw secret: ${act[0]?.summary}`);
  assert.ok(!JSON.stringify(detail.agents).includes(FAKE), 'agents.lastSummary holds the raw secret');
});

// REFUTATIONS (should pass)
test('refute: the same Post delivered twice counts once; a Post on another run id cannot be forged by tool_use_id', async (t) => {
  const s = await setup();
  t.after(() => s.srv.close());
  const p = { agent_id: 'sub1', agent_type: 'w', tool_name: 'Read', tool_use_id: 'dup', tool_input: { file_path: '/a' } };
  await s.post(p);
  await s.post(p);
  await s.post({ ...p, hook_event_name: 'PostToolUseFailure', error: 'x' });
  const d = (await s.api('GET', `/api/runs/${s.id}`)).json;
  assert.equal(d.agents.find((a) => a.id === 'sub1').toolCalls, 1);
  assert.equal((await s.api('GET', `/api/runs/${s.other}/activity?agent=sub1`)).json.length, 0);
});

test('refute: a log() call that moves an agent onto another run is not counted on either run', async (t) => {
  const s = await setup();
  t.after(() => s.srv.close());
  await s.post({ agent_id: 'sub1', agent_type: 'w', tool_name: 'Read', tool_use_id: 'r1', tool_input: { file_path: '/a' } });
  await s.post({ agent_id: 'sub1', tool_name: 'mcp__agent-monitor__log', tool_use_id: 'l1', tool_input: { run: s.other, note: 'x' }, tool_response: { content: [] } });
  const mine = (await s.api('GET', `/api/runs/${s.id}/activity?agent=sub1`)).json.filter((r) => r.event === 'tool');
  const theirs = (await s.api('GET', `/api/runs/${s.other}/activity?agent=sub1`)).json.filter((r) => r.event === 'tool');
  assert.deepEqual(mine.map((r) => r.toolUseId), ['r1']);
  assert.deepEqual(theirs, []);
});

test('refute: /activity limit and agent are clamped/parameterised; unknown run 404, missing agent 400', async (t) => {
  const s = await setup();
  t.after(() => s.srv.close());
  for (let i = 0; i < 230; i += 1) await s.post({ agent_id: 'sub1', agent_type: 'w', tool_name: 'Read', tool_use_id: `n${i}`, tool_input: { file_path: '/a' } });
  const get = (q) => s.api('GET', `/api/runs/${s.id}/activity?${q}`);
  assert.equal((await get('agent=sub1&limit=100000')).json.length, 200);
  assert.equal((await get('agent=sub1&limit=-9')).json.length, 1);
  assert.equal((await get('agent=sub1&limit=1e400')).json.length, 50);
  assert.equal((await get('agent=sub1&limit=abc')).json.length, 50);
  assert.equal((await get(`agent=${encodeURIComponent("sub1' OR '1'='1")}`)).json.length, 0);
  assert.equal((await get('limit=5')).status, 400);
  assert.equal((await s.api('GET', '/api/runs/nope/activity?agent=sub1')).status, 404);
  // Cross-origin reads are refused by the Origin check; a rebinding Host is refused by the Host check.
  assert.equal((await s.api('GET', `/api/runs/${s.id}/activity?agent=sub1`, { headers: { Origin: 'http://evil.example' } })).status, 403);
  assert.equal((await s.api('GET', `/api/runs/${s.id}/activity?agent=sub1`, { headers: { Host: 'evil.example:80' } })).status, 403);
});
