// Commit fill (B): a commit whose `[branch hash]` line the output hid is read back from git's reflog.
// Drives createHooks + openStore with real temp git repos; the deferred git call is awaited through defer.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { classifyChanges } from '../src/ledger.js';
import { tmp } from './helpers.js';

const fwd = (p) => p.replace(/\\/g, '/');
const ID = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
const sh = (cmd, cwd, env = {}) => execSync(cmd, { cwd, shell: 'bash', encoding: 'utf8', env: { ...process.env, ...ID, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
const DOT = '·';

// A repo with one old commit (dated 2020, so it is outside every window) on main.
function repo() {
  const dir = tmp('am-fill-repo');
  sh('git init -q -b main && echo 1 > a.txt && git add a.txt && git commit -q -m base', dir, { GIT_COMMITTER_DATE: '2020-01-01T00:00:00Z', GIT_AUTHOR_DATE: '2020-01-01T00:00:00Z' });
  return dir;
}

function setup() {
  const store = openStore(tmp('am-fill-db'));
  const projectsDir = tmp('am-fill-proj');
  const pend = [];
  const hooks = createHooks(store, { projectsDir, port: 4747, defer: (fn) => { pend.push(fn()); }, clock: () => Date.now() });
  const file = path.join(projectsDir, 'proj', 's1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  let n = 0;
  const ev = (name, extra) => hooks.handle({ session_id: 's1', transcript_path: file, hook_event_name: name, ...extra });
  // Runs `command` for real between Pre and Post; `between` runs extra git work in that window.
  async function go(command, cwd, { between, post = true } = {}) {
    const id = `u${++n}`;
    const base = { tool_name: 'Bash', tool_input: { command }, tool_use_id: id, cwd };
    if (post) ev('PreToolUse', base);
    let out = '';
    let err = null;
    try { out = sh(command, cwd); } catch (e) { err = e; out = String(e.stdout || ''); }
    if (between) between();
    if (err) ev('PostToolUseFailure', { ...base, error: `${out}${String(err.stderr || '')}` });
    else ev('PostToolUse', { ...base, tool_response: { stdout: out, stderr: '' } });
    await Promise.all(pend.splice(0));
    return store.changesOf(run.id).find((r) => r.toolUseId === id);
  }
  return { store, go, items: () => classifyChanges(store.changesOf(run.id)).items, close: () => store.close() };
}

const commitItems = (t) => t.items().filter((i) => i.kind === 'commit').reverse();

test('git commit -q: hash, subject, files and lines are filled in', async () => {
  const t = setup();
  const dir = repo();
  const r = await t.go('echo 2 > b.txt && git add b.txt && git commit -q -m "add b"', dir);
  assert.match(r.result, /\(commit details read from git\)/);
  const [c] = commitItems(t);
  assert.match(c.title, /^Committed [0-9a-f]{7} add b$/);
  assert.deepEqual(c.stats, { files: 1, insertions: 1, deletions: 0 });
  assert.ok(c.chips.includes(`git ${DOT} main`));
  t.close();
});

test('a commit piped through tail -1 (only the stats line survives) is filled', async () => {
  const t = setup();
  const dir = repo();
  await t.go('echo 2 > b.txt && git add b.txt && git commit -m "piped" | tail -1', dir);
  const [c] = commitItems(t);
  assert.match(c.title, /piped$/);
  assert.deepEqual(c.stats, { files: 1, insertions: 1, deletions: 0 });
  t.close();
});

test('commit then checkout main then ff-merge: the branch is the one committed on', async () => {
  const t = setup();
  const dir = repo();
  sh('git branch x', dir);
  await t.go('git checkout -q x && echo 3 > c.txt && git add c.txt && git commit -q -m "on x" && git checkout -q main && git merge --ff-only x', dir);
  const [c] = commitItems(t);
  assert.match(c.title, /on x$/);
  assert.ok(c.chips.includes(`git ${DOT} x`), c.chips.join('|'));
  assert.equal(c.stats.files, 1);
  t.close();
});

test('two commits in one command are both filled, oldest first', async () => {
  const t = setup();
  const dir = repo();
  await t.go('echo 1 > b.txt && git add b.txt && git commit -q -m first && echo 2 > c.txt && echo 3 > d.txt && git add c.txt d.txt && git commit -q -m second', dir);
  const cs = commitItems(t);
  assert.equal(cs.length, 2);
  assert.match(cs[0].title, /first$/);
  assert.match(cs[1].title, /second$/);
  assert.equal(cs[0].stats.files, 1);
  assert.equal(cs[1].stats.files, 2);
  t.close();
});

test('git -C <dir> targets that repo even when the hook cwd is elsewhere', async () => {
  const t = setup();
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'z.txt'), 'z\n');
  sh('git add z.txt', dir);
  await t.go(`git -C ${fwd(dir)} commit -q -m viaC`, tmp('am-fill-else'));
  const [c] = commitItems(t);
  assert.match(c.title, /viaC$/);
  assert.equal(c.stats.files, 1);
  t.close();
});

test('cd <dir> && git commit targets that repo', async () => {
  const t = setup();
  const dir = repo();
  fs.writeFileSync(path.join(dir, 'z.txt'), 'z\n');
  sh('git add z.txt', dir);
  await t.go(`cd ${fwd(dir)} && git commit -q -m viaCd`, tmp('am-fill-else'));
  const [c] = commitItems(t);
  assert.match(c.title, /viaCd$/);
  t.close();
});

test('nothing to commit / a failed commit: no fill', async () => {
  const t = setup();
  const dir = repo();
  const r = await t.go('git commit -q -m nothing', dir);
  assert.doesNotMatch(r.result || '', /read from git/);
  assert.equal(commitItems(t).length, 0);
  t.close();
});

test('ambiguous: an extra commit in the window means no fill', async () => {
  const t = setup();
  const dir = repo();
  const r = await t.go('echo 2 > b.txt && git add b.txt && git commit -q -m mine', dir, {
    between: () => sh('echo 9 > e.txt && git add e.txt && git commit -q -m other', dir),
  });
  assert.doesNotMatch(r.result || '', /read from git/);
  t.close();
});

test('a nonexistent directory: no throw, no fill', async () => {
  const t = setup();
  const missing = fwd(path.join(tmp('am-fill-gone'), 'nope'));
  const r = await t.go(`git -C ${missing} commit -q -m x`, tmp('am-fill-else'));
  assert.ok(r);
  assert.doesNotMatch(r.result || '', /read from git/);
  t.close();
});

test('a normal commit with its own [branch hash] line is left alone', async () => {
  const t = setup();
  const dir = repo();
  const r = await t.go('echo 2 > b.txt && git add b.txt && git commit -m plain', dir);
  assert.doesNotMatch(r.result, /read from git/);
  assert.match(commitItems(t)[0].title, /plain$/);
  t.close();
});

test('a Post-only call (no PreToolUse) is filled using the 10 minute window', async () => {
  const t = setup();
  const dir = repo();
  const r = await t.go('echo 2 > b.txt && git add b.txt && git commit -q -m postonly', dir, { post: false });
  assert.match(r.result, /read from git/);
  assert.match(commitItems(t)[0].title, /postonly$/);
  t.close();
});
