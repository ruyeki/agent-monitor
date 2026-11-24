// Holdout B: commit details read back from git when the command output hides them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { classifyChanges } from '../src/ledger.js';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

const OLD = { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' };
const git = (dir, args, env = {}) => execFileSync('git', ['-C', dir, ...args], { env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', ...env }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
function repo() {
  const dir = tmp('am-repo-');
  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['config', 'user.email', 't@t']); git(dir, ['config', 'user.name', 't']); git(dir, ['config', 'core.autocrlf', 'false']);
  fs.writeFileSync(path.join(dir, 'a.txt'), 'base\n');
  git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', 'base'], OLD);
  return dir;
}
const doCommit = (dir, subject, name = `${subject.replace(/\W/g, '_').slice(0, 40)}.txt`, text = 'x\n') => {
  fs.writeFileSync(path.join(dir, name), text); git(dir, ['add', '-A']); git(dir, ['commit', '-q', '-m', subject]);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms = 5000) { const t = Date.now(); while (Date.now() - t < ms) { if (fn()) return true; await sleep(50); } return false; }
const LINE = /^\[.+? [0-9a-f]{7,40}\] /m;

function harness(cwd) {
  const cmds = {};
  const store = openStore(tmp('am-cf-'));
  const hooks = createHooks(store, { projectsDir: tmp('am-p-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s', run.id);
  const ev = (hook_event_name, x) => hooks.handle({ session_id: 's', cwd, hook_event_name, ...x });
  const result = () => store.changesOf(run.id)[0]?.result ?? '';
  return {
    store, run, result,
    pre: (id, command) => { cmds[id] = command; return ev('PreToolUse', { tool_name: 'Bash', tool_input: { command }, tool_use_id: id }); },
    post: (id, stdout = '', stderr = '') => ev('PostToolUse', { tool_name: 'Bash', tool_input: { command: cmds[id] }, tool_use_id: id, tool_response: { stdout, stderr } }),
    fail: (id, error = 'boom') => ev('PostToolUseFailure', { tool_name: 'Bash', tool_input: { command: cmds[id] }, tool_use_id: id, error }),
    items: () => classifyChanges(store.changesOf(run.id)),
  };
}
const filled = (h) => until(() => LINE.test(h.result()));

test('quiet commit (-q, empty output) gets hash, subject and stats filled from git', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -q -m "quiet one"');
  doCommit(dir, 'quiet one', 'q.txt', 'a\nb\nc\n');
  h.post('u1');
  assert.ok(await filled(h), h.result());
  const { items, summary } = h.items();
  assert.match(items[0].title, /Committed [0-9a-f]{7} quiet one/);
  assert.deepEqual(items[0].stats, { files: 1, insertions: 3, deletions: 0 });
  assert.match(items[0].chips[0], /main/);
  assert.equal(summary.commitsWithStats, 1);
  assert.equal(summary.files, 1);
});

test('piped output (| tail -1) hides the commit line: still filled', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -m "piped" | tail -1');
  doCommit(dir, 'piped', 'p.txt');
  h.post('u1', ' 1 file changed, 1 insertion(+)\n');
  assert.ok(await filled(h), h.result());
  assert.match(h.items().items[0].title, /piped/);
});

test('git -C <dir> from a different cwd reads that dir', async () => {
  const dir = repo(); const h = harness(tmp('am-else-'));
  h.pre('u1', `git -C ${dir} commit -q -m "elsewhere"`);
  doCommit(dir, 'elsewhere');
  h.post('u1');
  assert.ok(await filled(h), h.result());
  assert.match(h.items().items[0].title, /elsewhere/);
});

test('cd <dir> && git commit reads that dir', async () => {
  const dir = repo(); const h = harness(tmp('am-else-'));
  h.pre('u1', `cd ${dir} && git add -A && git commit -q -m "viacd"`);
  doCommit(dir, 'viacd');
  h.post('u1');
  assert.ok(await filled(h), h.result());
  assert.match(h.items().items[0].title, /viacd/);
});

test('two commits in one command: both filled, oldest first, own stats', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -q -m "first" && git commit -q -m "second"');
  doCommit(dir, 'first', 'f1.txt', '1\n');
  doCommit(dir, 'second', 'f2.txt', '1\n2\n');
  h.post('u1');
  assert.ok(await until(() => (h.result().match(/^\[.+? [0-9a-f]{7,40}\] /gm) || []).length === 2), h.result());
  const items = [...h.items().items].reverse(); // newest first in the API
  assert.equal(items.length, 2);
  assert.match(items[0].title, /first/); assert.match(items[1].title, /second/);
  assert.equal(items[0].stats.insertions, 1); assert.equal(items[1].stats.insertions, 2);
});

test('commit then checkout main then ff merge: the commit keeps its own branch name', async () => {
  const dir = repo(); git(dir, ['checkout', '-q', '-b', 'feat/z']);
  const h = harness(dir);
  h.pre('u1', 'git commit -q -m "on feat" && git checkout -q main && git merge --ff-only feat/z');
  doCommit(dir, 'on feat');
  git(dir, ['checkout', '-q', 'main']); git(dir, ['merge', '-q', '--ff-only', 'feat/z']);
  h.post('u1');
  assert.ok(await filled(h), h.result());
  assert.match(h.result(), /\[feat\/z [0-9a-f]{7,40}\] on feat/);
});

test('output that already has the [branch hash] line is left alone', async () => {
  const dir = repo(); const h = harness(dir);
  const out = '[main abc1234] real\n 1 file changed, 1 insertion(+)\n';
  h.pre('u1', 'git commit -m real');
  doCommit(dir, 'real');
  h.post('u1', out);
  await sleep(1500);
  assert.equal(h.result().trim(), out.trim());
});

test('commit that did not happen (nothing to commit): no fill, no invented commit', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -q -m "nothing"');
  h.fail('u1', 'nothing to commit, working tree clean');
  await sleep(1500);
  assert.doesNotMatch(h.result(), LINE);
  assert.equal(h.items().items.length, 0);
});

test('ambiguous: one commit in the command but two new commits in the window: no fill', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -q -m "mine"');
  doCommit(dir, 'mine'); doCommit(dir, 'someone elses');
  h.post('u1');
  await sleep(1500);
  assert.doesNotMatch(h.result(), LINE);
});

test('commit inside ssh is not filled from the local repo', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'ssh percy "git commit -q -m remote"');
  doCommit(dir, 'remote');
  h.post('u1');
  await sleep(1500);
  assert.doesNotMatch(h.result(), LINE);
});

test('missing directory or a directory with $: no fill, no throw, hook still answers', async () => {
  const h = harness('/definitely/not/here');
  assert.doesNotThrow(() => h.pre('u1', 'git commit -q -m x'));
  assert.doesNotThrow(() => h.post('u1', 'out'));
  const h2 = harness(tmp('am-e-'));
  h2.pre('u2', 'cd $HOME/repo && git commit -q -m x');
  h2.post('u2', 'out');
  await sleep(1000);
  assert.equal(h2.result().trim(), 'out');
  assert.equal(h.result().trim(), 'out');
});

test('two commits aimed at two different directories: skipped', async () => {
  const a = repo(); const b = repo(); const h = harness(a);
  h.pre('u1', `git -C ${a} commit -q -m one && git -C ${b} commit -q -m two`);
  doCommit(a, 'one'); doCommit(b, 'two');
  h.post('u1');
  await sleep(1500);
  assert.doesNotMatch(h.result(), LINE);
});

test('secrets in a subject are redacted in the stored fill', async () => {
  const dir = repo(); const h = harness(dir);
  const tok = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4';
  h.pre('u1', 'git commit -q -m "token"');
  doCommit(dir, `use ${tok} now`, 's.txt');
  h.post('u1');
  assert.ok(await filled(h), h.result());
  assert.doesNotMatch(h.result(), /ghp_a1B2c3D4e5/);
});

test('a very long subject is cut to 200 chars', async () => {
  const dir = repo(); const h = harness(dir);
  h.pre('u1', 'git commit -q -m long');
  doCommit(dir, 'L'.repeat(400), 'l.txt');
  h.post('u1');
  assert.ok(await filled(h), h.result());
  assert.doesNotMatch(h.result(), /L{201}/);
});

test('the hook answers at once: the git read never delays the response', async () => {
  const dir = repo();
  const store = openStore(tmp('am-cf-'));
  let deferred = 0;
  const hooks = createHooks(store, { projectsDir: tmp('am-p-'), port: 4747, defer: () => { deferred++; }, clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s', run.id);
  const ev = (hook_event_name, x) => hooks.handle({ session_id: 's', cwd: dir, hook_event_name, ...x });
  ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit -q -m x' }, tool_use_id: 'u1' });
  doCommit(dir, 'x');
  await ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_response: { stdout: '', stderr: '' } });
  assert.doesNotMatch(store.changesOf(run.id)[0].result ?? '', LINE); // nothing ran inline; deferred work never executed here
});
