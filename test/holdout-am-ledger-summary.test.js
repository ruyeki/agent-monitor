// Holdout A + C: summary accounts for every kind; several pushes / PRs in one command each get their own part.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges } from '../src/ledger.js';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

let n = 0;
const row = (input, result = null, outcome = 'ok') => { n++; return { id: n, at: 1000 + n, agentId: 'a', tool: 'Bash', toolUseId: `h${n}`, input, result, outcome }; };
const COMMIT = '[feat/x 274eae5] Answer things\n 4 files changed, 169 insertions(+), 120 deletions(-)\n';
const PUSH = 'To github.com:o/r.git\n   4ec2e9f..3a44b3a  main -> main\n';

const chron = (rows) => { const r = classifyChanges(rows); return { ...r, items: [...r.items].reverse() }; }; // items come newest first
const sumKeys = (s) => s.commits + s.pushes + s.prs + s.merges + s.worktrees + s.databases + s.tasks + s.restarts;

test('summary has the new fields, all zero when empty', () => {
  const { summary } = classifyChanges([]);
  for (const k of ['prs', 'merges', 'worktrees', 'databases', 'commitsWithStats']) assert.equal(summary[k], 0, k);
  for (const k of ['commits', 'files', 'insertions', 'deletions', 'pushes', 'tasks', 'restarts', 'total']) assert.equal(summary[k], 0, k);
  assert.deepEqual(summary.permanent, []);
});

test('every change kind is counted and the counts add up to total', () => {
  const heph = { id: 99, at: 1099, agentId: 'a', tool: 'mcp__hephaestus__update_task', toolUseId: 'hh', input: JSON.stringify({ task_id: 5, status: 'Done' }), result: 'ok', outcome: 'ok' };
  const { items, summary: s } = classifyChanges([
    row('git commit -m x', COMMIT),
    row('git push origin main', PUSH),
    row('gh pr create --title T', 'https://github.com/o/r/pull/12\n'),
    row('gh pr merge 12'),
    row('git merge feat/x'),
    row('git worktree add C:\\wt\\x -b feat/x'),
    row('git worktree remove C:\\wt\\x'),
    row('pm2 restart agent-monitor'),
    heph,
  ]);
  assert.equal(s.total, items.length);
  assert.equal(s.prs, 2);
  assert.equal(s.merges, 1);
  assert.equal(s.worktrees, 2);
  assert.equal(s.commits, 1);
  assert.equal(s.pushes, 1);
  assert.equal(s.restarts, 1);
  assert.equal(sumKeys(s), s.total);
});

test('database kinds (backup + upgrade) are counted under databases and still add up', () => {
  const { items, summary: s } = classifyChanges([
    row('pg_dump nike > /tmp/nike.sql'),
    row('cp agent-monitor.db agent-monitor.db.bak'),
    row('node bin/agent-monitor.js db upgrade'),
    row('git commit -m x', COMMIT),
  ]);
  assert.equal(s.total, items.length);
  assert.equal(sumKeys(s), s.total);
  assert.equal(s.databases, items.filter((i) => i.kind === 'db-backup' || i.kind === 'db-upgrade').length);
});

test('invariant holds for a run of only pushes, a PR and a worktree (the live nike-dm-7-5 shape)', () => {
  const { items, summary: s } = classifyChanges([
    row('git push origin a', PUSH), row('git push origin b', PUSH),
    row('gh pr create --title T', 'https://github.com/o/r/pull/3\n'),
    row('git worktree add C:\\wt\\y -b y'),
  ]);
  assert.equal(items.length, 4);
  assert.equal(s.total, 4);
  assert.equal(sumKeys(s), 4);
  assert.equal(s.pushes, 2); assert.equal(s.prs, 1); assert.equal(s.worktrees, 1); assert.equal(s.commits, 0);
});

test('commitsWithStats counts only commits whose stats are known', () => {
  const { summary: s } = classifyChanges([row('git commit -m a', COMMIT), row('git commit -q -m b', ''), row('git commit -q -m c', '')]);
  assert.equal(s.commits, 3);
  assert.equal(s.commitsWithStats, 1);
  assert.equal(s.files, 4);
  const none = classifyChanges([row('git commit -q -m b', '')]).summary;
  assert.equal(none.commitsWithStats, 0);
  assert.equal(none.commits, 1);
});

test('two commits in one command and in one result: each its own stats (nth)', () => {
  const out = '[feat/x 1111111] one\n 1 file changed, 2 insertions(+)\n[feat/x 2222222] two\n 3 files changed, 4 insertions(+), 5 deletions(-)\n';
  const { items, summary: s } = chron([row('git commit -m one && git commit -m two', out)]);
  assert.equal(items.length, 2);
  assert.deepEqual(items.map((i) => i.stats.files), [1, 3]);
  assert.equal(s.files, 4); assert.equal(s.commitsWithStats, 2);
});

test('C: two pushes in one command give two rows with their own branch', () => {
  const out = 'To github.com:o/r.git\n   1111111..2222222  fix/a -> fix/a\nTo github.com:o/r.git\n   3333333..4444444  main -> main\n';
  const { items } = chron([row('git push origin fix/a && git push origin main', out)]);
  assert.equal(items.length, 2);
  assert.match(items[0].title, /fix\/a/);
  assert.match(items[1].title, /\bmain\b/);
  assert.doesNotMatch(items[1].title, /fix\/a/);
  assert.notDeepEqual(items[0].chips, items[1].chips);
});

test('C: different remotes per segment, and a new-branch segment next to a normal one', () => {
  const out = 'To github.com:o/r1.git\n * [new branch]      x -> x\nTo github.com:o/r2.git\n   1111111..2222222  main -> main\n';
  const { items } = chron([row('git push r1 x && git push r2 main', out)]);
  assert.equal(items.length, 2);
  assert.match(items[0].detail, /New branch/);
  assert.doesNotMatch(items[1].detail, /New branch/);
  assert.ok(items[0].chips.includes('o/r1')); assert.ok(items[1].chips.includes('o/r2'));
});

test('C: first push up-to-date, second real: only the real one is a row', () => {
  const out = 'Everything up-to-date\nTo github.com:o/r.git\n   1111111..2222222  main -> main\n';
  const { items, summary } = chron([row('git push origin a && git push origin main', out)]);
  assert.equal(items.length, 1);
  assert.match(items[0].title, /main/);
  assert.equal(summary.pushes, 1);
});

test('C: two gh pr create in one command give two different PR numbers', () => {
  const out = 'https://github.com/o/r/pull/507\nhttps://github.com/o/r/pull/508\n';
  const { items } = chron([row('gh pr create --title A && gh pr create --title B', out)]);
  assert.equal(items.length, 2);
  assert.match(items[0].title, /#507/); assert.match(items[1].title, /#508/);
  assert.equal(items[0].detail, 'A'); assert.equal(items[1].detail, 'B');
});

test('C: a single push / PR still parses as before', () => {
  const [p] = classifyChanges([row('git push origin main', PUSH)]).items;
  assert.match(p.title, /Pushed main to GitHub/);
  const [r] = classifyChanges([row('gh pr create --title T', 'noise\nhttps://github.com/o/r/pull/12\n')]).items;
  assert.match(r.title, /#12/);
});

test('C: GitHub remote: banners are dropped; two new-branch pushes + two PR URLs still resolve, result <= 1000', () => {
  const store = openStore(tmp('am-ho-'));
  const hooks = createHooks(store, { projectsDir: tmp('am-p-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s', run.id);
  const ev = (hook_event_name, x) => hooks.handle({ session_id: 's', cwd: '/x', hook_event_name, ...x });
  const cmd = 'git push -u origin feat/a && git push -u origin feat/b && gh pr create --title A --body a && gh pr create --title B --body b';
  ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'u1' });
  const NL = String.fromCharCode(10);
  const banner = (b) => ['remote: ', `remote: Create a pull request for '${b}' on GitHub by visiting:`, `remote:      https://github.com/o/r/pull/new/${b}`, 'remote: ', ''].join(NL);
  const push = (org, repo, b) => banner(b) + `To github.com:${org}/${repo}.git` + NL + ` * [new branch]      ${b} -> ${b}` + NL;
  const out = push('o', 'r', 'feat/a') + push('p', 'q', 'feat/b') + 'https://github.com/o/r/pull/507' + NL + 'https://github.com/p/q/pull/508' + NL;
  ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: cmd }, tool_use_id: 'u1', tool_response: { stdout: out, stderr: '' } });
  const [c] = store.changesOf(run.id);
  assert.ok(c.result.length <= 1000, `stored ${c.result.length}`);
  assert.ok(!/^remote:/m.test(c.result));
  const { items } = chron([c]);
  const pushes = items.filter((i) => i.kind === 'push'), prs = items.filter((i) => i.kind === 'pr-create');
  assert.equal(pushes.length, 2); assert.equal(prs.length, 2);
  assert.match(pushes[0].title, /feat\/a/); assert.match(pushes[1].title, /feat\/b/);
  assert.match(JSON.stringify(pushes[0]), /o\/r/); assert.match(JSON.stringify(pushes[1]), /p\/q/);
  assert.match(prs[0].title, /#507/); assert.match(prs[1].title, /#508/);
});
