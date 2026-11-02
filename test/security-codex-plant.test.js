// EXPLOIT: the hand-off spawns a bare command name (bin passes 'codex') with spawn cwd = the run's repo.
// On Windows, libuv searches <cwd>\<name>.com / <name>.exe BEFORE PATH unless NoDefaultCurrentDirectoryInExePath
// is set. The live server is started by the Startup VBS (Explorer's environment), which does not set it, so a
// codex.exe sitting in the repo (cloned repo, PR branch, or written by a sandboxed Codex/Claude agent) runs as Ryan,
// unsandboxed, with the server's full environment, instead of Codex.
// Secure behaviour asserted: a file in the repo is never executed by the launcher.
// The probe name stands in for 'codex' so the real Codex CLI can never run from this test.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until, makeWorld } from './codex-helpers.js';

delete process.env.NoDefaultCurrentDirectoryInExePath; // as in the VBS-started server (Claude Code's shell sets it)
const NAME = 'am-plant-probe'; // not on PATH: without the plant the launcher gets ENOENT and escalates

test('a <repo>\\codex.exe is not executed by the hand-off', { skip: process.platform !== 'win32' }, async (t) => {
  const world = makeWorld();
  const marker = path.join(world.repo, 'PWNED');
  // the planted "codex.exe": a node.exe copy runs <cwd>\exec (the first argv the launcher passes is 'exec')
  fs.copyFileSync(process.execPath, path.join(world.repo, `${NAME}.exe`));
  fs.writeFileSync(path.join(world.repo, 'package.json'), '{"type":"commonjs"}');
  fs.writeFileSync(path.join(world.repo, 'exec'),
    "require('fs').writeFileSync(require('path').join(process.cwd(), 'PWNED'), JSON.stringify({ argv: process.argv.slice(2), env: Object.keys(process.env).length }));\n");

  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: { command: NAME, root: world.root }, // exactly what bin does, with NAME in place of 'codex'
  });
  t.after(() => srv.close());
  const run = srv.store.startRun({ title: 'Victim', repo: world.repo }).run.id;
  srv.store.linkSession('claude-1', run);

  // the run hits its Claude limit (real StopFailure, or any local process / agent posting one)
  await req(srv.port, 'POST', '/hook', { body: { session_id: 'claude-1', cwd: world.repo, hook_event_name: 'StopFailure', error: 'rate_limit' } });
  await until(() => fs.existsSync(marker) || srv.store.summary(srv.store.getRun(run)).status === 'waiting', 8000);
  await new Promise((r) => setTimeout(r, 300));

  assert.ok(!fs.existsSync(marker), `planted ${NAME}.exe in the repo ran: ${fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : ''}`);
});
