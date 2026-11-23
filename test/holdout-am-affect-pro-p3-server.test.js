// Holdout (#2289 piece 3, C8): changes table at PreToolUse, redaction before storage, caps, GET /api/runs/:id/ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { boot, hook, mcpClient, runIdOf, until, mainFile } from './holdout-v2-helpers.js';

async function world(sid = 's1') {
  const S = await boot();
  const mcp = await mcpClient(S.url);
  const tp = mainFile(S.projects, sid);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, '');
  const runs = {};
  const H = (s, ev, extra = {}) => hook(S.port, { hook_event_name: ev, session_id: s, transcript_path: mainFile(S.projects, s), cwd: '/x', ...extra });
  const startRun = async (s, title) => {
    const id = runIdOf((await mcp.call('start_run', { title })).text);
    fs.writeFileSync(mainFile(S.projects, s), '');
    await H(s, 'PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title }, tool_use_id: `l-${s}`, tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame) · round 0/5 · status active` }] } });
    return id;
  };
  const pre = (s, tuid, tool, input) => H(s, 'PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: tuid });
  const post = (s, tuid, tool, resp) => H(s, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: resp ?? { stdout: '' }, tool_use_id: tuid });
  const fail = (s, tuid, tool, error) => H(s, 'PostToolUseFailure', { tool_name: tool, tool_input: {}, tool_use_id: tuid, error });
  const ledger = async (id) => S.api('GET', `/api/runs/${id}/ledger`);
  const rows = (sql, ...a) => { const db = new DatabaseSync(path.join(S.home, 'agent-monitor.db')); try { return db.prepare(sql).all(...a); } finally { db.close(); } };
  const exec = (sql) => { const db = new DatabaseSync(path.join(S.home, 'agent-monitor.db')); try { db.exec(sql); } finally { db.close(); } };
  return { S, startRun, pre, post, fail, ledger, rows, exec, close: () => S.srv.close() };
}

test('a git push is written to changes at PreToolUse, completed at PostToolUse, and shows in the ledger as permanent', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'Ledger run');
    await w.pre('s1', 'p1', 'Bash', { command: 'git push origin main' });
    const open = w.rows('SELECT * FROM changes WHERE run_id = ?', id);
    assert.equal(open.length, 1, 'row written at PreToolUse');
    assert.equal(open[0].tool_use_id, 'p1');
    await w.post('s1', 'p1', 'Bash', { stdout: 'main -> main', stderr: '' });
    const done = w.rows('SELECT * FROM changes WHERE run_id = ?', id)[0];
    assert.equal(done.outcome, 'ok');
    assert.match(done.result, /main -> main/);
    assert.ok(done.ended_at);
    const r = await w.ledger(id);
    assert.equal(r.status, 200);
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].tag, 'permanent');
    assert.equal(r.json.summary.pushes, 1);
  } finally { await w.close(); }
});

test('non-candidate tool calls write no changes row; a failed call is stored with outcome error and left out of the ledger', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'R');
    await w.pre('s1', 'n1', 'Bash', { command: 'ls -la' }); await w.post('s1', 'n1', 'Bash');
    await w.pre('s1', 'n2', 'Read', { file_path: '/x' }); await w.post('s1', 'n2', 'Read');
    await w.pre('s1', 'n3', 'Bash', { command: 'git status' }); await w.post('s1', 'n3', 'Bash');
    assert.equal(w.rows('SELECT COUNT(*) n FROM changes WHERE run_id = ?', id)[0].n, 0);
    await w.pre('s1', 'f1', 'Bash', { command: 'git push origin main' });
    await w.fail('s1', 'f1', 'Bash', 'fatal: no remote');
    assert.equal(w.rows('SELECT outcome FROM changes WHERE tool_use_id = ?', 'f1')[0].outcome, 'error');
    assert.equal((await w.ledger(id)).json.items.length, 0);
  } finally { await w.close(); }
});

test('secrets are redacted before storage (input and result) and never come back from the ledger', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'R');
    await w.pre('s1', 'b1', 'Bash', { command: 'PGPASSWORD=hunter2hunter2 pg_dump -h db nike > /tmp/nike.sql' });
    await w.post('s1', 'b1', 'Bash', { stdout: 'connecting with postgres://u:p4ssw0rdZZ@db/nike', stderr: '' });
    const all = JSON.stringify(w.rows('SELECT * FROM changes'));
    assert.ok(!all.includes('hunter2hunter2'), 'password in input stored');
    assert.ok(!all.includes('p4ssw0rdZZ'), 'password in result stored');
    assert.ok(all.includes('pg_dump'), 'the command itself is kept');
    const r = await w.ledger(id);
    assert.ok(!r.text.includes('hunter2hunter2') && !r.text.includes('p4ssw0rdZZ'), 'secret in the ledger response');
    assert.equal(r.json.items.length, 1);
    assert.equal(r.json.items[0].tag, 'backup');
  } finally { await w.close(); }
});

test('older runs: activity rows with no changes row appear in the ledger, redacted', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'R');
    await w.pre('s1', 'o1', 'Bash', { command: 'git push origin main' }); await w.post('s1', 'o1', 'Bash');
    await w.pre('s1', 'o2', 'Bash', { command: 'PGPASSWORD=oldsecret99 pg_dump nike > /tmp/o.sql' }); await w.post('s1', 'o2', 'Bash');
    w.exec('DELETE FROM changes'); // as if the run predates the ledger
    const r = await w.ledger(id);
    assert.equal(r.status, 200);
    assert.ok(r.json.items.some((i) => i.tag === 'permanent'), 'push from activity');
    assert.ok(r.json.items.some((i) => i.tag === 'backup'), 'backup from activity');
    assert.ok(!r.text.includes('oldsecret99'), 'activity summary must be redacted too');
  } finally { await w.close(); }
});

test('input is capped at 2000 chars and result at 1000, and a run keeps at most 300 change rows', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'R');
    await w.pre('s1', 'big', 'Bash', { command: `git commit -m "${'x'.repeat(6000)}"` });
    await w.post('s1', 'big', 'Bash', { stdout: 'y'.repeat(6000), stderr: '' });
    const big = w.rows('SELECT input, result FROM changes WHERE tool_use_id = ?', 'big')[0];
    assert.ok(big.input.length <= 2000, `input ${big.input.length}`);
    assert.ok(big.result.length <= 1000, `result ${big.result.length}`);
    assert.ok(big.input.length > 100, 'not dropped');
    for (let i = 0; i < 310; i++) await w.pre('s1', `c${i}`, 'Bash', { command: `git commit -m "c${i}"` });
    const n = w.rows('SELECT COUNT(*) n FROM changes WHERE run_id = ?', id)[0].n;
    assert.ok(n <= 300, `rows kept: ${n}`);
    assert.ok(n >= 290, `cap should trim, not wipe: ${n}`);
    assert.equal(w.rows('SELECT COUNT(*) n FROM changes WHERE tool_use_id = ?', 'c309')[0].n, 1, 'newest row survives');
  } finally { await w.close(); }
});

test('ledger endpoint: 404 for an unknown run, empty result for a run without changes, rows of another run never leak', async () => {
  const w = await world();
  try {
    assert.equal((await w.ledger('no-such-run')).status, 404);
    const a = await w.startRun('s1', 'Run A');
    const b = await w.startRun('s2', 'Run B');
    const empty = await w.ledger(a);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.json.items, []);
    assert.equal(empty.json.summary.total, 0);
    await w.pre('s2', 'bp', 'Bash', { command: 'git push origin main' }); await w.post('s2', 'bp', 'Bash');
    assert.equal((await w.ledger(a)).json.items.length, 0, 'A has nothing');
    assert.equal((await w.ledger(b)).json.items.length, 1);
    assert.equal((await w.S.api('GET', '/api/runs/%2e%2e/ledger')).status, 404);
  } finally { await w.close(); }
});

test('Hephaestus status change is recorded for the ledger (MCP input as JSON)', async () => {
  const w = await world();
  try {
    const id = await w.startRun('s1', 'R');
    await w.pre('s1', 'h1', 'mcp__hephaestus__update_task', { task_id: 2289, status: 'Done' }); await w.post('s1', 'h1', 'mcp__hephaestus__update_task', { content: [{ type: 'text', text: 'ok' }] });
    await w.pre('s1', 'h2', 'mcp__hephaestus__get_task', { task_id: 2289 });
    const r = (await w.ledger(id)).json;
    assert.equal(r.items.length, 1);
    assert.match(r.items[0].title, /Set Hephaestus #2289 status/);
    assert.equal(r.summary.tasks, 1);
    assert.equal(w.rows('SELECT COUNT(*) n FROM changes WHERE tool_use_id = ?', 'h2')[0].n, 0);
  } finally { await w.close(); }
});
