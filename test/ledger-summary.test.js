// Ledger summary (A): tiles add up to the total, new fields. Double counts (C): one row per push / PR in one command.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges } from '../src/ledger.js';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

let n = 0;
const row = (input, result = null, extra = {}) => {
  n++;
  return { id: n, at: 1000 + n, agentId: 'main:s1', tool: 'Bash', toolUseId: `tu${n}`, input, result, outcome: 'ok', ...extra };
};
const parts = (s) => s.commits + s.pushes + s.prs + s.merges + s.worktrees + s.databases + s.tasks + s.restarts;

const COMMIT_OUT = '[main 274eae5] Add a thing\n 4 files changed, 169 insertions(+), 120 deletions(-)\n';
const PUSH_OUT = 'To github.com:o/r.git\n   4ec2e9f..3a44b3a  main -> main\n';
const heph = { id: 90, at: 1090, agentId: null, tool: 'mcp__hephaestus__update_task', toolUseId: 'h', input: '{"task_id":5,"status":"Done"}', result: 'ok', outcome: 'ok' };

test('summary: every kind counts, the parts add up to the total, new fields are present', () => {
  const { items, summary: s } = classifyChanges([
    row('git commit -m a', COMMIT_OUT),
    row('git commit -q -m b', ''),
    row('git push origin main', PUSH_OUT),
    row('gh pr create --title t', 'https://github.com/o/r/pull/7\n'),
    row('gh pr merge 7', 'Merged pull request #7'),
    row('git merge feat/x', 'Fast-forward'),
    row('git worktree add C:/wt/x -b x', ''),
    row('git worktree remove C:/wt/x', ''),
    row('cp data/a.db data/a.db.bak', ''),
    row('flask db upgrade', ''),
    row('pm2 restart app', ''),
    heph,
  ]);
  assert.equal(s.total, items.length);
  assert.equal(parts(s), s.total);
  assert.deepEqual(
    { c: s.commits, cs: s.commitsWithStats, p: s.pushes, pr: s.prs, m: s.merges, w: s.worktrees, d: s.databases, t: s.tasks, r: s.restarts, f: s.files, i: s.insertions, l: s.deletions },
    { c: 2, cs: 1, p: 1, pr: 2, m: 1, w: 2, d: 2, t: 1, r: 1, f: 4, i: 169, l: 120 },
  );
});

test('summary: a run with only some kinds has zeros for the rest and still adds up', () => {
  const { summary: s } = classifyChanges([row('git worktree add C:/wt/y', ''), row('pm2 restart app', '')]);
  assert.equal(parts(s), 2);
  assert.equal(s.total, 2);
  assert.deepEqual([s.commits, s.commitsWithStats, s.pushes, s.prs, s.merges, s.databases, s.tasks], [0, 0, 0, 0, 0, 0, 0]);
});

test('summary: commits without stats do not add files or lines', () => {
  const { summary: s } = classifyChanges([row('git commit -q -m a', '')]);
  assert.deepEqual([s.commits, s.commitsWithStats, s.files, s.insertions, s.deletions], [1, 0, 0, 0, 0]);
});

test('empty run: all counts zero', () => {
  const { summary: s } = classifyChanges([]);
  assert.equal(s.total, 0);
  assert.equal(parts(s), 0);
  assert.equal(s.commitsWithStats, 0);
});

const TWO_PUSHES = 'To github.com:o/r.git\n   aaaaaaa..bbbbbbb  x -> x\nTo github.com:o/r.git\n * [new branch]      y -> y\nhttps://github.com/o/r/pull/508\nhttps://github.com/o/r/pull/509\n';

test('two pushes and two PR creates in one command: one row each with its own branch and PR number', () => {
  const { items } = classifyChanges([row('git push origin x && git push -u origin y && gh pr create --title a && gh pr create --title b', TWO_PUSHES)]);
  const pushes = items.filter((i) => i.kind === 'push').reverse();
  const prs = items.filter((i) => i.kind === 'pr-create').reverse();
  assert.deepEqual(pushes.map((p) => p.title), ['Pushed x to GitHub', 'Pushed y to GitHub']);
  assert.match(pushes[0].chips.join(' '), /aaaaaaa/);
  assert.match(pushes[1].detail, /New branch/);
  assert.doesNotMatch(pushes[0].detail, /New branch/);
  assert.deepEqual(prs.map((p) => p.title), ['Opened pull request #508', 'Opened pull request #509']);
});

test('an up-to-date push before a real push keeps the rows aligned', () => {
  const out = 'Everything up-to-date\nTo github.com:o/r.git\n   aaaaaaa..bbbbbbb  y -> y\n';
  const { items } = classifyChanges([row('git push origin x && git push origin y', out)]);
  assert.equal(items.length, 1);
  assert.equal(items[0].title, 'Pushed y to GitHub');
  assert.match(items[0].chips.join(' '), /aaaaaaa/);
});

test('a single push and a result with no markers behave as before', () => {
  const { items } = classifyChanges([row('git push origin main', PUSH_OUT)]);
  assert.equal(items[0].title, 'Pushed main to GitHub');
  assert.equal(classifyChanges([row('git push origin feat', '')]).items[0].title, 'Pushed feat to GitHub');
});

// GitHub's remote: banner lines (five per new-branch push) used to push the push lines out of the 1000-char cap.
const banner = (b) => [
  'remote: Enumerating objects: 9, done.',
  'remote: Counting objects: 100% (9/9), done.',
  'remote: Total 5 (delta 4), reused 0 (delta 0), pack-reused 0 (from 0)',
  `remote: Create a pull request for '${b}' on GitHub by visiting:`,
  `remote:      https://github.com/org/repo/pull/new/${b}`,
].join('\n');
const newBranchPush = (b) => `${banner(b)}\nTo github.com:org/repo.git\n * [new branch]      ${b} -> ${b}`;

test('a push-and-PR chain with GitHub banners: the stored result keeps every push and PR under the cap', () => {
  const store = openStore(tmp('am-summary-db'));
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  const hooks = createHooks(store, { projectsDir: tmp('am-summary-proj'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const creating = 'Creating pull request for fix/a into main in org/repo, with the title and body taken from the branch commits and notes.';
  const creatingB = 'Creating pull request for fix/b into main in org/repo, with the title and body taken from the branch commits and notes.';
  const command = 'git push -u origin fix/a && gh pr create --title A --body x && git push -u origin fix/b && gh pr create --title B --body y';
  const stdout = `${creating}\nhttps://github.com/org/repo/pull/11\n${creatingB}\nhttps://github.com/org/repo/pull/12\n`;
  const stderr = `${newBranchPush('fix/a')}\n${newBranchPush('fix/b')}\n`;
  hooks.handle({ session_id: 's1', cwd: '/x', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command }, tool_response: { stdout, stderr }, tool_use_id: 'tu-chain' });

  const rows = store.changesOf(run.id);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].result.length <= 1000, `result is ${rows[0].result.length} chars`);
  assert.doesNotMatch(rows[0].result, /remote:/);

  const { items } = classifyChanges(rows);
  const pushes = items.filter((i) => i.kind === 'push');
  const prs = items.filter((i) => i.kind === 'pr-create');
  assert.deepEqual(pushes.map((p) => p.title).sort(), ['Pushed fix/a to GitHub', 'Pushed fix/b to GitHub']);
  for (const p of pushes) assert.ok(p.chips.includes('org/repo'), `chips: ${p.chips.join(', ')}`);
  assert.deepEqual(prs.map((p) => p.title).sort(), ['Opened pull request #11', 'Opened pull request #12']);
});
