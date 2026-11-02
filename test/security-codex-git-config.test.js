// EXPLOIT: the hand-off runs `git status` in a directory taken from hook payloads (cwd) or start_run's repo.
// git honours the repo's own .git/config, and `core.fsmonitor = <command>` makes `git status` run that command:
// a work tree under the root whose .git/config someone else wrote (an extracted archive, a folder an agent prepared)
// runs code as Ryan when a run there hands off. (rev-parse alone does not run it; status does.)
// Secure behaviour asserted: the launcher's git calls run no command configured by the repo.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { STUB, tmp, until, makeWorld, calls, readLog } from './codex-helpers.js';

test('a repo-configured core.fsmonitor command does not run during the hand-off', async (t) => {
  const world = makeWorld();
  const marker = path.join(world.base, 'FSMONITOR_RAN');
  const hook = path.join(world.base, 'fsmon.cjs');
  fs.writeFileSync(hook, `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran'); process.stdout.write('\\0');\n`);
  execFileSync('git', ['-C', world.repo, 'config', 'core.fsmonitor', `"${process.execPath.replace(/\\/g, '/')}" "${hook.replace(/\\/g, '/')}"`], { windowsHide: true });

  const log = path.join(world.base, 'stub.log');
  const env = { ...process.env, AM_STUB_LOG: log, AM_STUB_CALLS: calls([{ lines: [{ type: 'thread.started', thread_id: 'thr-g' }] }]) };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: { command: process.execPath, args: [STUB], root: world.root, env },
  });
  t.after(() => srv.close());
  const run = srv.store.startRun({ title: 'Victim' }).run.id; // no repo: the hook cwd is the candidate
  srv.store.linkSession('claude-1', run);
  await req(srv.port, 'POST', '/hook', { body: { session_id: 'claude-1', cwd: world.repo, hook_event_name: 'StopFailure', error: 'rate_limit' } });
  await until(() => readLog(log).length === 1, 8000);

  assert.equal(readLog(log)[0]?.cwd.toLowerCase(), world.repo.toLowerCase(), 'sanity: Codex was launched in the repo');
  assert.ok(!fs.existsSync(marker), 'git status ran the core.fsmonitor command from the repo config');
});
