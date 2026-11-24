// Security tests for the commit fill (run am-ledger-summary). Each test asserts the SAFE behaviour. Linux only (git on PATH).
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

const test = (name, fn) => nodeTest(name, { skip: process.platform === 'win32' && 'payloads are sh scripts' }, fn);
const { planFill, readCommits } = await import('../src/commitfill.js');
const { openStore } = await import('../src/store.js');
const { createHooks } = await import('../src/hooks.js');

const ID = { GIT_AUTHOR_NAME: 'a', GIT_AUTHOR_EMAIL: 'a@b.c', GIT_COMMITTER_NAME: 'a', GIT_COMMITTER_EMAIL: 'a@b.c' };
const tmp = (n) => fs.mkdtempSync(path.join(os.tmpdir(), `wh-${n}-`));
const sh = (cmd, cwd) => execSync(cmd, { cwd, shell: 'bash', encoding: 'utf8', env: { ...process.env, ...ID }, stdio: ['ignore', 'pipe', 'pipe'] });

// A program that leaves a marker file each time git runs it, and also answers like gpg so signing works.
function evilProgram(dir, marker) {
  const p = path.join(dir, 'evil.sh');
  fs.writeFileSync(p, `#!/bin/sh\necho ran >> ${marker}\ncat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 1 x' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nAAAA\\n-----END PGP SIGNATURE-----\\n'\nexit 0\n`, { mode: 0o755 });
  return p;
}

// A repo whose own .git/config makes `git log` run a program: a signed commit plus log.showSignature + gpg.program.
function signatureRepo() {
  const dir = tmp('sig');
  const marker = path.join(dir, 'MARKER');
  const evil = evilProgram(dir, marker);
  sh(`git init -q -b main && git config gpg.program ${evil} && echo 1 > a && git add a && git commit -q -S -m signed && git config log.showSignature true`, dir);
  fs.rmSync(marker, { force: true });
  return { dir, marker };
}

test('fill dir: a cd inside a subshell does not move the commit', () => {
  // The commit runs in /home/u/repo; the fill must not read /tmp/untrusted.
  const plan = planFill('(cd /tmp/untrusted && ls) && git commit -q -m fix', '/home/u/repo', '');
  assert.notEqual(plan?.dir, '/tmp/untrusted');
});

test('fill dir: a cd that fails (|| true) or is undone (popd) is not used', () => {
  assert.notEqual(planFill('cd /tmp/untrusted || true; git commit -q -m fix', '/home/u/repo', '')?.dir, '/tmp/untrusted');
  assert.notEqual(planFill('pushd /tmp/untrusted; popd; git commit -q -m fix', '/home/u/repo', '')?.dir, '/tmp/untrusted');
});

test('git log in a repo with log.showSignature + gpg.program does not run that program', async () => {
  const { dir, marker } = signatureRepo();
  await readCommits({ dir, count: 1 }, 0);
  assert.equal(fs.existsSync(marker), false, 'the fill ran the repo-configured gpg.program');
});

test('git log in a partial clone does not lazy-fetch (core.sshCommand from the repo config)', async () => {
  const src = tmp('src');
  sh('git init -q -b main && git config uploadpack.allowFilter true && echo 1 > a && git add a && git commit -q -m one && echo 2 > a && git commit -qam two', src);
  const root = tmp('pc');
  const dir = path.join(root, 'clone');
  sh(`git clone -q --filter=blob:none --no-checkout file://${src} clone`, root);
  const marker = path.join(root, 'MARKER');
  const evil = evilProgram(root, marker);
  sh(`git config remote.origin.url ssh://nohost.invalid/x && git config core.sshCommand ${evil}`, dir);
  await readCommits({ dir, count: 1 }, 0);
  assert.equal(fs.existsSync(marker), false, 'the fill lazily fetched through the repo-configured core.sshCommand');
});

// The hooks harness from test/commit-fill.test.js, cut down: Pre, run the command for real, Post, await the fill.
async function through(command, cwd) {
  const store = openStore(tmp('db'));
  const projectsDir = tmp('proj');
  const pend = [];
  const hooks = createHooks(store, { projectsDir, port: 4747, defer: (fn) => { pend.push(fn()); }, clock: () => Date.now() });
  const file = path.join(projectsDir, 'p', 's1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  const base = { session_id: 's1', transcript_path: file, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'u1', cwd };
  hooks.handle({ ...base, hook_event_name: 'PreToolUse' });
  const out = sh(command, cwd);
  return { after: async (check) => { check(); hooks.handle({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: out, stderr: '' } }); await Promise.all(pend); } };
}

test('end to end: a quiet commit in a repo the agent built makes the server (outside any sandbox) run its gpg.program', async () => {
  // A sandboxed agent can `git init` a fresh repo and write its .git/config; its own `git commit -q` runs no program.
  const { dir, marker } = signatureRepo();
  const call = await through(`git -C ${dir} commit -q --allow-empty -m work`, os.tmpdir());
  await call.after(() => assert.equal(fs.existsSync(marker), false, 'precondition: the commit itself ran no program'));
  assert.equal(fs.existsSync(marker), false, 'the commit fill ran the repo-configured gpg.program in the Agent Monitor process');
});

test('end to end: an approved `(cd X && ls) && git commit -q` makes the Agent Monitor server run X\'s gpg.program', async () => {
  const { dir: hostile, marker } = signatureRepo();
  const mine = tmp('mine');
  sh('git init -q -b main && echo 1 > a && git add a && git commit -q -m base', mine);
  const store = openStore(tmp('db'));
  const projectsDir = tmp('proj');
  const pend = [];
  const hooks = createHooks(store, { projectsDir, port: 4747, defer: (fn) => { pend.push(fn()); }, clock: () => Date.now() });
  const file = path.join(projectsDir, 'p', 's1.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'x\n');
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s1', run.id);
  // `ls` in the hostile dir runs nothing from it; the commit runs in the agent's own repo.
  const command = `(cd ${hostile} && ls) && echo 2 > a && git commit -qam work`;
  const base = { session_id: 's1', transcript_path: file, tool_name: 'Bash', tool_input: { command }, tool_use_id: 'u1', cwd: mine };
  hooks.handle({ ...base, hook_event_name: 'PreToolUse' });
  const out = sh(command, mine);
  assert.equal(fs.existsSync(marker), false, 'precondition: the command itself never ran the hostile program');
  hooks.handle({ ...base, hook_event_name: 'PostToolUse', tool_response: { stdout: out, stderr: '' } });
  await Promise.all(pend);
  assert.equal(fs.existsSync(marker), false, 'the commit fill ran git in the hostile dir, which ran its gpg.program');
});
