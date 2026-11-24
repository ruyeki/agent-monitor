// Holdout (#2289 piece 3, C8): the pure ledger helpers in src/ledger.js.
// Rows are given with snake_case and camelCase keys so either row shape works; commands are given as tool_input objects or plain strings.
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges, isChangeCandidate, redact } from '../src/ledger.js';

let n = 0;
const T0 = Date.parse('2026-11-22T10:00:00Z');
const row = (tool, input, over = {}) => {
  const id = ++n;
  const at = new Date(T0 + id * 1000).toISOString();
  const inp = typeof input === 'string' ? input : JSON.stringify(input);
  return { id, run_id: 'r', agent_id: 'main:s', agentId: 'main:s', at, tool, tool_use_id: `u${id}`, toolUseId: `u${id}`, input: inp, summary: inp, result: '', outcome: 'ok', ended_at: at, endedAt: at, ...over };
};
const sh = (cmd, over = {}) => row('Bash', cmd, over);
const items = (...rows) => classifyChanges(rows).items;
const one = (r) => { const it = items(r); assert.equal(it.length, 1, `one item for ${r.input}: got ${JSON.stringify(it)}`); return it[0]; };
const cand = (tool, cmd) => Boolean(isChangeCandidate(tool, { command: cmd })) || Boolean(isChangeCandidate(tool, cmd));
const candNo = (tool, cmd) => !isChangeCandidate(tool, { command: cmd }) && !isChangeCandidate(tool, cmd);

test('isChangeCandidate: change commands yes, read-only commands and other tools no', () => {
  for (const c of ['git push origin main', 'git push --force origin feat', 'git commit -m "x"', 'git merge feat', 'gh pr create --title x', 'gh pr merge 5 --squash',
    'git worktree add ../w -b x', 'git worktree remove ../w', 'pm2 restart agent-monitor', 'docker restart pg', 'sudo systemctl restart nginx', 'pg_dump nike > /tmp/n.sql',
    'cp agent-monitor.db agent-monitor.db.bak', 'git add -A && git commit -m x && git push origin main']) assert.ok(cand('Bash', c), c);
  assert.ok(cand('PowerShell', 'git push origin main'));
  assert.ok(isChangeCandidate('mcp__hephaestus__update_task', { task_id: 1, status: 'Done' }));
  for (const c of ['ls -la', 'git status', 'git diff HEAD', 'git log --oneline -5', 'npm test', 'cat package.json', 'git branch -a', 'gh pr view 5', 'gh pr list']) assert.ok(candNo('Bash', c), c);
  for (const t of ['Read', 'Edit', 'Write', 'Grep', 'mcp__hephaestus__get_task']) assert.ok(!isChangeCandidate(t, { file_path: 'x' }), t);
  assert.ok(!isChangeCandidate('mcp__hephaestus__update_task', { task_id: 1, description: 'notes only' }), 'update_task without a status is not a change');
  assert.doesNotThrow(() => isChangeCandidate(undefined, undefined));
  assert.doesNotThrow(() => isChangeCandidate('Bash', null));
});

test('git push: permanent, Can\'t undo, code; force push too; the summary counts it and lists it as permanent', () => {
  const a = sh('git push origin main', { result: 'To github.com:x/y.git\n   abc1234..def5678  main -> main' });
  const b = sh('git push --force-with-lease origin feat', { result: 'To github.com:x/y.git\n + 1111111...2222222 feat -> feat (forced update)' });
  const r = classifyChanges([a, b]);
  assert.equal(r.items.length, 2);
  for (const it of r.items) {
    assert.equal(it.tag, 'permanent');
    assert.match(it.tagLabel, /Can.t be undone/i);
    assert.equal(it.category, 'code');
    assert.equal(typeof it.title, 'string');
    assert.ok(Array.isArray(it.chips));
    assert.ok(it.id !== undefined && it.at);
  }
  assert.equal(r.summary.pushes, 2);
  assert.equal(r.summary.total, 2);
  assert.equal(r.summary.permanent.length, 2);
});

test('git commit: reversible, parsed from git output; becomes info "Pushed" when a later push succeeded; a failed push does not', () => {
  const out = '[main 1a2b3c4] Fix the thing\n 3 files changed, 10 insertions(+), 2 deletions(-)';
  const c = it0(sh('git commit -m "Fix the thing"', { result: out }));
  assert.equal(c.tag, 'reversible');
  assert.match(c.tagLabel, /Can change back/i);
  assert.equal(c.category, 'code');
  const text = JSON.stringify(c);
  assert.ok(text.includes('1a2b3c4'), 'hash parsed');
  assert.ok(text.includes('Fix the thing'), 'subject parsed');
  const r = classifyChanges([sh('git commit -m "Fix the thing"', { result: out })]);
  assert.deepEqual([r.summary.commits, r.summary.files, r.summary.insertions, r.summary.deletions], [1, 3, 10, 2]);
  const pushed = classifyChanges([sh('git commit -m "Fix the thing"', { result: out }), sh('git push origin main', { result: 'main -> main' })]).items;
  const cm = pushed.find((x) => x.kind === 'commit'); // order-independent (the mockup lists newest first)
  assert.equal(cm.tag, 'info');
  assert.match(cm.tagLabel, /Pushed/i);
  const failedPush = classifyChanges([sh('git commit -m "Fix the thing"', { result: out }), sh('git push origin main', { result: 'error: failed to push some refs', outcome: 'error' })]).items;
  assert.equal(failedPush.find((x) => x.kind === 'commit').tag, 'reversible');
  // a push BEFORE the commit does not count
  const before = classifyChanges([sh('git push origin main', { result: 'main -> main' }), sh('git commit -m "x"', { result: out })]).items;
  assert.equal(before.find((x) => x.kind === 'commit').tag, 'reversible');
});
const it0 = (r) => one(r);

test('merge, gh pr create: reversible; gh pr merge: permanent; worktree add reversible, remove info "Cleaned up"', () => {
  assert.equal(one(sh('git merge feat/x', { result: 'Merge made by the ort strategy.' })).tag, 'reversible');
  assert.equal(one(sh('gh pr create --title "T" --body "B"', { result: 'https://github.com/x/y/pull/9' })).tag, 'reversible');
  assert.equal(one(sh('gh pr merge 9 --squash', { result: 'Merged pull request #9' })).tag, 'permanent');
  assert.equal(one(sh('git worktree add ../w -b feat/z')).tag, 'reversible');
  const rm = one(sh('git worktree remove ../w'));
  assert.equal(rm.tag, 'info');
  assert.match(rm.tagLabel, /Cleaned up/i);
});

test('DB backup is "Backup kept"; a DB upgrade is permanent unless a backup came earlier in the run', () => {
  for (const c of ['cp /data/agent-monitor.db /data/agent-monitor.db.bak.db', 'sqlite3 a.db ".backup b.db"', 'pg_dump -Fc nike -f /tmp/nike.dump']) {
    const it = one(sh(c));
    assert.equal(it.tag, 'backup', c);
    assert.match(it.tagLabel, /Backup kept/i);
    assert.equal(it.category, 'machines');
  }
  const up = (cmd) => sh(cmd, { result: 'INFO  Running upgrade 0014 -> 0015' });
  assert.equal(one(up('alembic upgrade head')).tag, 'permanent', 'no backup first');
  const withBackup = items(sh('pg_dump nike > /tmp/n.sql'), up('alembic upgrade head'));
  assert.equal(withBackup.length, 2);
  assert.equal(withBackup[1].tag, 'backup');
  const backupAfter = items(up('alembic upgrade head'), sh('pg_dump nike > /tmp/n.sql'));
  assert.equal(backupAfter.find((x) => x.kind !== 'db-backup').tag, 'permanent', 'a backup taken AFTER the upgrade does not cover it');
});

test('Hephaestus update_task with a status: reversible, title "Set Hephaestus #<id> status", chip is the new status, category tasks', () => {
  const it = one(row('mcp__hephaestus__update_task', { task_id: 2289, status: 'Done', description: 'long note' }));
  assert.equal(it.tag, 'reversible');
  assert.equal(it.category, 'tasks');
  assert.match(it.title, /Set Hephaestus #2289 status/);
  assert.ok(it.chips.some((c) => /Done/.test(c)), JSON.stringify(it.chips));
  assert.equal(classifyChanges([row('mcp__hephaestus__update_task', { task_id: 2289, status: 'Done' })]).summary.tasks, 1);
  assert.equal(items(row('mcp__hephaestus__update_task', { task_id: 2289, description: 'only notes' })).length, 0);
});

test('server restarts: info "Ran once", machines', () => {
  for (const c of ['pm2 restart agent-monitor', 'docker restart nike-pg', 'sudo systemctl restart agent-monitor']) {
    const it = one(sh(c));
    assert.equal(it.tag, 'info', c);
    assert.match(it.tagLabel, /Ran once/i);
    assert.equal(it.category, 'machines');
  }
});

test('failed calls are skipped: outcome error, or a result that starts with fatal: or error:', () => {
  assert.equal(items(sh('git push origin main', { outcome: 'error', result: 'boom' })).length, 0);
  assert.equal(items(sh('git push origin main', { result: 'fatal: could not read from remote' })).length, 0);
  assert.equal(items(sh('git commit -m x', { result: 'error: gpg failed to sign' })).length, 0);
  assert.equal(items(sh('git push origin main', { outcome: 'ok', result: 'main -> main' })).length, 1);
  assert.equal(classifyChanges([sh('git push origin main', { outcome: 'error' })]).summary.total, 0);
});

test('older runs: an activity-style row (no result, no outcome) is still classified from its summary', () => {
  const a = { id: 1, at: new Date(T0).toISOString(), agentId: 'main:s', agent_id: 'main:s', tool: 'Bash', summary: 'git push origin main', input: 'git push origin main' };
  const r = classifyChanges([a]);
  assert.equal(r.items.length, 1);
  assert.equal(r.items[0].tag, 'permanent');
});

test('classifyChanges: empty and junk input never throw; items are in time order with unique ids; non-candidates produce nothing', () => {
  assert.deepEqual(classifyChanges([]).items, []);
  assert.equal(classifyChanges([]).summary.total, 0);
  assert.deepEqual(classifyChanges([]).summary.permanent, []);
  assert.doesNotThrow(() => classifyChanges(null));
  assert.doesNotThrow(() => classifyChanges([null, {}, { tool: 'Bash' }, { tool: 'Bash', input: null, result: 5 }, { tool: 7, input: {} }]));
  const a = sh('git worktree add ../w'); const b = sh('git push origin main'); const c = sh('ls -la'); const d = sh('npm test');
  const got = classifyChanges([b, a, c, d]).items; // out of order in
  assert.equal(got.length, 2);
  assert.equal(new Set(got.map((x) => x.id)).size, 2);
  const ts = got.map((x) => Date.parse(x.at));
  assert.ok(ts[0] !== ts[1], 'distinct times'); // sorted by time (either direction), not input order: input was [push, worktree] and the result is not left as given unless that is time order
  assert.deepEqual(got.map((x) => x.kind), ts[0] < ts[1] ? ['worktree-add', 'push'] : ['push', 'worktree-add']);
  assert.equal(classifyChanges([a, b, c, d]).summary.total, 2);
});

test('compound command: a chained add + commit + push still yields the permanent push', () => {
  const it = items(sh('git add -A && git commit -m "x" && git push origin main', { result: '[main abc1234] x\n 1 file changed, 1 insertion(+)\nmain -> main' }));
  assert.ok(it.some((x) => x.tag === 'permanent'), JSON.stringify(it));
});

test('redact: removes secrets, keeps the rest of the text', () => {
  const secrets = {
    'PGPASSWORD=hunter2 psql -h db nike': 'hunter2',
    'DB_PASSWORD=abc123xyz run.sh': 'abc123xyz',
    'export API_TOKEN=tok_live_9f8e7d6c && go': 'tok_live_9f8e7d6c',
    'CLIENT_SECRET="s3cr3t value" go': 's3cr3t',
    'git clone https://deploy:p4ssw0rd@github.com/x/y.git': 'p4ssw0rd',
    'curl -H "Authorization: Bearer abcDEF123.ghi-456_xyz" https://api.x': 'abcDEF123.ghi-456_xyz',
    [`git push https://x:ghp_${'a'.repeat(36)}@github.com/x/y`]: 'a'.repeat(36),
    [`GH=gho_${'B'.repeat(36)} gh api /user`]: 'B'.repeat(36),
    'ANTHROPIC=sk-ant-api03-AbCdEf0123456789-xyzXYZ0123456789 claude': 'AbCdEf0123456789',
    '{"password":"hunter2hunter2","user":"bob"}': 'hunter2hunter2',
    'mysql --password=topsecret99 -u root': 'topsecret99',
  };
  for (const [input, secret] of Object.entries(secrets)) {
    const out = redact(input);
    assert.equal(typeof out, 'string');
    assert.ok(!out.includes(secret), `still has ${secret}: ${out}`);
  }
  assert.match(redact('PGPASSWORD=hunter2 psql -h db nike'), /psql -h db nike/, 'the command itself is kept');
  assert.match(redact('git clone https://deploy:p4ssw0rd@github.com/x/y.git'), /github\.com\/x\/y\.git/, 'host and path kept');
  assert.match(redact('{"password":"hunter2hunter2","user":"bob"}'), /bob/);
  for (const plain of ['git push origin main', 'ls -la /tmp', 'git commit -m "fix login page"', 'https://github.com/x/y/pull/9']) assert.equal(redact(plain), plain, 'unchanged');
  assert.doesNotThrow(() => redact(null));
  assert.doesNotThrow(() => redact(undefined));
  assert.doesNotThrow(() => redact(42));
  const twice = redact('PGPASSWORD=hunter2 psql'); assert.ok(!redact(twice).includes('hunter2'));
});
