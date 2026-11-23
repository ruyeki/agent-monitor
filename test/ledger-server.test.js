// Ledger server (C8): change rows written at Pre/Post, redaction, caps, and GET /api/runs/:id/ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';
import { boot } from './holdout-helpers.js';

const GH = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
const PUSH = 'To https://github.com/o/r.git\n   1234567..89abcde  main -> main\n';

function setup(dir = tmp('am-ledger-')) {
  const store = openStore(dir);
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  const ev = (hook_event_name, extra = {}) => hooks.handle({ session_id: 'cs', cwd: '/x', hook_event_name, ...extra });
  const pre = (id, command, tool = 'Bash', tool_input = { command }) => ev('PreToolUse', { tool_name: tool, tool_input, tool_use_id: id });
  const post = (id, tool_response, tool = 'Bash') => ev('PostToolUse', { tool_name: tool, tool_use_id: id, tool_response });
  return { dir, store, ev, pre, post, id: run.id };
}

test('a candidate Bash call writes a changes row at Pre and completes it at Post', () => {
  const t = setup();
  t.pre('u1', 'git push origin main');
  let [c] = t.store.changesOf(t.id);
  assert.equal(c.input, 'git push origin main');
  assert.equal(c.tool, 'Bash');
  assert.equal(c.result, null);
  assert.equal(c.endedAt, null);
  t.post('u1', { stdout: PUSH, stderr: 'warn' });
  [c] = t.store.changesOf(t.id);
  assert.equal(c.outcome, 'ok');
  assert.match(c.result, /89abcde/);
  assert.match(c.result, /warn/);
  assert.ok(c.endedAt);
  t.store.close();
});

test('non-candidate calls write no changes row', () => {
  const t = setup();
  t.pre('u1', 'git status && ls');
  t.pre('u2', 'git log --oneline');
  t.pre('u3', null, 'Read', { file_path: '/x' });
  assert.equal(t.store.changesOf(t.id).length, 0);
  t.post('u1', { stdout: 'ok' });
  assert.equal(t.store.changesOf(t.id).length, 0);
  t.store.close();
});

test('secrets in the command and the response are redacted in the DB and the API', async () => {
  const dir = tmp('am-ledger-');
  const t = setup(dir);
  t.pre('u1', `git push https://me:hunter2secret@github.com/o/r.git main && PGPASSWORD=s3cr3tpw echo ${GH}`);
  t.post('u1', { stdout: `${PUSH}token ${GH} Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123`, stderr: '' });
  const [c] = t.store.changesOf(t.id);
  for (const bad of ['hunter2secret', 's3cr3tpw', GH, 'abcdefghijklmnopqrstuvwxyz0123']) {
    assert.ok(!c.input.includes(bad) && !c.result.includes(bad), `${bad} stored`);
  }
  assert.match(c.input, /\*\*\*/);
  t.store.close();
  const b = await boot({ home: dir });
  try {
    const r = await b.api('GET', `/api/runs/${t.id}/ledger`);
    assert.equal(r.status, 200);
    assert.ok(!/hunter2secret|s3cr3tpw|ghp_/.test(r.text));
    assert.ok(r.json.items.length >= 1);
  } finally { await b.srv.close(); }
});

test('caps: input 2000, result 1000, 300 rows per run; a secret at the cut is masked whole', () => {
  const t = setup();
  t.pre('u1', `git commit -m "${'x'.repeat(3000)}"`);
  t.post('u1', { stdout: 'y'.repeat(5000) });
  const [c] = t.store.changesOf(t.id);
  assert.equal(c.input.length, 2000);
  assert.equal(c.result.length, 1000);
  t.pre('u2', `git push ${'z'.repeat(1990)} ${GH}`);
  const u2 = t.store.changesOf(t.id).find((r) => r.toolUseId === 'u2');
  assert.ok(!u2.input.includes('ghp_'));
  for (let i = 0; i < 320; i++) t.pre(`m${i}`, 'git push origin main');
  const rows = t.store.changesOf(t.id);
  assert.equal(rows.length, 300);
  assert.equal(rows.at(-1).toolUseId, 'm319');
  assert.ok(!rows.some((r) => r.toolUseId === 'u1'));
  t.store.close();
});

test('failed calls: PostToolUseFailure completes the row with outcome error and the redacted error text', () => {
  const t = setup();
  t.pre('u1', 'git push origin main');
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'u1', error: `fatal: auth failed ${GH}` });
  const [c] = t.store.changesOf(t.id);
  assert.equal(c.outcome, 'error');
  assert.match(c.result, /^fatal: auth failed/);
  assert.ok(!c.result.includes('ghp_'));
  t.store.close();
});

test('an MCP Hephaestus status update is recorded as redacted JSON', () => {
  const t = setup();
  t.pre('h1', null, 'mcp__hephaestus__update_task', { task_id: 2289, status: 'Done', token: 'abc123secretvalue' });
  const [c] = t.store.changesOf(t.id);
  assert.match(c.input, /"status":"Done"/);
  assert.ok(!c.input.includes('abc123secretvalue'));
  t.store.close();
});

test('the ledger endpoint: items newest first, summary, legacy activity fallback, 404, no cross-run rows', async () => {
  const dir = tmp('am-ledger-');
  const t = setup(dir);
  t.pre('c1', 'git commit -m "first"');
  t.post('c1', { stdout: '[main aaaaaaa] first\n 1 file changed, 2 insertions(+), 1 deletion(-)\n' });
  t.pre('p1', 'git push origin main');
  t.post('p1', { stdout: PUSH });
  // activity rows next to changes rows are NOT added back (capped-away or non-candidate calls)
  t.store.addActivity(t.id, 'main:cs', 'tool', 'Bash', 'git push origin main', 'p1');
  t.store.addActivity(t.id, 'main:cs', 'tool', 'Bash', 'git merge feature-x', null);
  // legacy run: activity rows only (one has no tool_use_id, one carries a secret)
  const legacy = t.store.startRun({ title: 'Legacy' }).run;
  t.store.addActivity(legacy.id, 'a', 'tool', 'Bash', 'git merge feature-x', null);
  t.store.addActivity(legacy.id, 'a', 'tool', 'Bash', 'git push https://u:topsecretpw@github.com/o/r.git dev', 'old1');
  t.store.addActivity(legacy.id, 'a', 'tool', 'Bash', 'git status', 'old2');
  // another run must never leak in
  const other = t.store.startRun({ title: 'Other' }).run;
  t.store.addChange(other.id, 'a', 'Bash', 'o1', 'git push origin elsewhere');
  t.store.addActivity(other.id, 'a', 'tool', 'Bash', 'git merge other-run-branch', 'o2');
  t.store.close();
  const b = await boot({ home: dir });
  try {
    const r = await b.api('GET', `/api/runs/${t.id}/ledger`);
    assert.equal(r.status, 200);
    const titles = r.json.items.map((i) => i.title);
    assert.ok(!titles.some((x) => /elsewhere|other-run/.test(x)));
    assert.equal(r.json.items.filter((i) => i.kind === 'push').length, 1);
    assert.equal(r.json.items.filter((i) => i.kind === 'merge').length, 0, 'no activity-only rows next to changes rows');
    assert.equal(r.json.items.filter((i) => i.kind === 'commit').length, 1);
    const ats = r.json.items.map((i) => i.at);
    assert.deepEqual(ats, [...ats].sort().reverse(), 'newest first');
    assert.equal(r.json.summary.commits, 1);
    assert.equal(r.json.summary.pushes, 1);
    assert.equal(r.json.summary.total, r.json.items.length);
    const l = await b.api('GET', `/api/runs/${legacy.id}/ledger`);
    assert.ok(!l.text.includes('topsecretpw'));
    assert.equal(l.json.items.filter((i) => i.kind === 'push').length, 1);
    assert.equal(l.json.items.filter((i) => i.kind === 'merge').length, 1);
    const o = await b.api('GET', `/api/runs/${other.id}/ledger`);
    assert.equal(o.json.items.length, 1, 'the other run sees only its own push');
    const nf = await b.api('GET', '/api/runs/no-such-run/ledger');
    assert.equal(nf.status, 404);
  } finally { await b.srv.close(); }
});
