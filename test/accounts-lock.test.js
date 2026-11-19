import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { withLock, accountsDir } from '../src/accounts/state.js';
import { tmp } from './accounts-helpers.js';

test('withLock: a stale lock is taken over', async (t) => {
  const dir = tmp(t);
  const lock = path.join(accountsDir(dir), '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  assert.equal(await withLock(dir, async () => 'ok'), 'ok');
});

test('withLock: a stale lock that a rival refreshed between the two stats is not removed', async (t) => {
  const dir = tmp(t);
  const lock = path.join(accountsDir(dir), '.lock');
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, '1');
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(lock, old, old);
  const realStat = fs.statSync;
  let calls = 0;
  fs.statSync = (p, ...a) => {
    if (String(p) === lock && ++calls === 2) { const n = new Date(); fs.utimesSync(lock, n, n); } // the rival's takeover lands here
    return realStat(p, ...a);
  };
  t.after(() => { fs.statSync = realStat; });
  await assert.rejects(withLock(dir, async () => 'no', { waitMs: 150 }), /busy/);
  assert.ok(fs.existsSync(lock), "the rival's fresh lock survives");
});
