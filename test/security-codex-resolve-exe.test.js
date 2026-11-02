// RE-CHECK of resolveExe: try to make the launcher hand spawn a planted file through PATH oddities.
// spawn is a recorder (nothing runs); the probe name is not on the real PATH.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { startServer } from '../src/server.js';
import { req } from './holdout-helpers.js';
import { tmp, until, makeWorld } from './codex-helpers.js';

delete process.env.NoDefaultCurrentDirectoryInExePath;
const NAME = 'am-wh-probe';

function fakeChild() {
  const c = new EventEmitter();
  c.pid = 0; c.stdin = { on() {}, end() {} }; c.stderr = { resume() {} };
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  setTimeout(() => { c.stdout.emit('end'); c.emit('close', 0); }, 10);
  return c;
}

async function launchWith(t, world, pathValue, extraEnv = {}) {
  const spawned = [];
  const env = { ...extraEnv, SystemRoot: process.env.SystemRoot, Path: pathValue };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: { command: NAME, root: world.root, env, spawn: (cmd, argv, opts) => { spawned.push({ cmd, cwd: opts.cwd }); return fakeChild(); } },
  });
  t.after(() => srv.close());
  const run = srv.store.startRun({ title: 'Victim', repo: world.repo }).run.id;
  srv.store.linkSession('claude-1', run);
  await req(srv.port, 'POST', '/hook', { body: { session_id: 'claude-1', hook_event_name: 'StopFailure', error: 'rate_limit' } });
  await until(() => spawned.length || srv.store.summary(srv.store.getRun(run)).status === 'waiting', 5000);
  return { spawned, note: srv.store.getRun(run).note };
}

const gitDir = (process.env.Path || process.env.PATH).split(';').find((d) => d && path.isAbsolute(d) && fs.existsSync(path.join(d, 'git.exe')));
const plant = (dir, file) => { fs.mkdirSync(dir, { recursive: true }); fs.copyFileSync(process.execPath, path.join(dir, file)); };

test('relative, empty and drive-relative PATH entries never reach a planted exe', { skip: process.platform !== 'win32' }, async (t) => {
  const world = makeWorld();
  plant(world.repo, `${NAME}.exe`);
  plant(path.join(world.repo, 'bin'), `${NAME}.exe`);
  plant(process.cwd(), `${NAME}.exe`);
  t.after(() => fs.rmSync(path.join(process.cwd(), `${NAME}.exe`), { force: true }));
  const drive = world.repo.slice(0, 2);
  const { spawned, note } = await launchWith(t, world, ['.', '', 'bin', `.${path.sep}bin`, `${drive}bin`, ' '].join(';'));
  assert.deepEqual(spawned, [], `spawned ${JSON.stringify(spawned)}`);
  assert.match(String(note), /not found on PATH/);
});

test('PATHEXT and non-exe files are ignored; an exe-named directory is skipped', { skip: process.platform !== 'win32' }, async (t) => {
  const world = makeWorld();
  const d1 = path.join(world.base, 'p1'); const d2 = path.join(world.base, 'p2');
  fs.mkdirSync(path.join(d1, `${NAME}.exe`), { recursive: true }); // a directory named like the exe
  fs.writeFileSync(path.join(d1, `${NAME}.bat`), '@echo pwned');
  fs.writeFileSync(path.join(d1, `${NAME}.cmd`), '@echo pwned');
  fs.writeFileSync(path.join(d1, `${NAME}.lnk`), 'x');
  plant(d2, `${NAME}.exe`);
  const { spawned } = await launchWith(t, world, [d1, d2, gitDir].join(';'), { PATHEXT: '.BAT;.CMD;.LNK' });
  assert.equal(spawned.length, 1);
  assert.equal(spawned[0].cmd.toLowerCase(), path.join(d2, `${NAME}.exe`).toLowerCase());
});
