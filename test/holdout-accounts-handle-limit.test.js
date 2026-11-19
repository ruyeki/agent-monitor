// AC3/AC4 manager side: handleLimit decisions, attribution, duplicate suppression, failed swaps.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, cred, writeCred, readCred, readCredText, reading, nm, NOW, H, sec, iso } from './holdout-accounts-helpers.js';

const setup = (t, o = {}) => world(t, { accounts: ['ana', 'bob', 'cyd'], active: 'ana', ...o });
const hit = (extra = {}) => ({ at: iso(NOW), resetsAt: iso(NOW + 3 * H), source: 'stopfailure', ...extra });

test('no accounts registered: next is null and nothing happens', async (t) => {
  const w = await world(t, { accounts: [] });
  const r = await w.mgr.handleLimit({ ...hit(), runAccount: 'ana' });
  assert.equal(r.next ?? null, null);
  assert.equal(r.switched ?? false, false);
});

test('a run on ana hits its limit: switches to the account with the most left, never ana, and records the limit', async (t) => {
  const w = await setup(t);
  w.mgr.recordReading('bob', reading(80, 10)); // left 20
  w.mgr.recordReading('cyd', reading(30, 30)); // left 70
  const r = await w.mgr.handleLimit({ ...hit(), runAccount: 'ana' });
  assert.equal(nm(r.next), 'cyd');
  assert.equal(r.switched, true);
  assert.equal(nm(r.hitAccount), 'ana');
  assert.equal(!!r.duplicate, false);
  assert.equal(w.mgr.activeName(), 'cyd');
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-cyd');
  assert.equal(nm(w.mgr.pickBest({ exclude: ['bob', 'cyd'] })), null, 'ana is now limited');
});

test('the account that hit the limit is never the next one, even with the most left; limited ones are skipped', async (t) => {
  const w = await setup(t);
  w.mgr.recordReading('bob', reading(97, 0));
  w.mgr.recordLimit('cyd', { at: iso(NOW - H), resetsAt: iso(NOW + 4 * H) });
  const r = await w.mgr.handleLimit({ ...hit(), runAccount: 'ana' });
  assert.equal(nm(r.next), 'bob');
  assert.equal(w.mgr.activeName(), 'bob');
});

test('every account out: next is null, no swap, the file is untouched (caller falls back to Codex)', async (t) => {
  const w = await setup(t);
  w.mgr.recordLimit('bob', { at: iso(NOW - H), resetsAt: iso(NOW + 4 * H) });
  w.mgr.recordLimit('cyd', { at: iso(NOW - H), resetsAt: iso(NOW + 4 * H) });
  const before = readCredText(w.home);
  const r = await w.mgr.handleLimit({ ...hit(), runAccount: 'ana' });
  assert.equal(nm(r.next), null);
  assert.equal(!!r.switched, false);
  assert.equal(readCredText(w.home), before);
});

test('attribution: with no run account, a hit whose reset equals another account\'s stored window belongs to THAT account', async (t) => {
  const w = await setup(t); // ana active
  const R = sec(NOW + 2 * H);
  w.mgr.recordReading('bob', reading(60, 10, { fiveReset: R }));
  const r = await w.mgr.handleLimit({ at: iso(NOW), resetsAt: iso(R * 1000), source: 'transcript' });
  assert.equal(nm(r.hitAccount), 'bob');
  assert.equal(!!r.duplicate, true, 'a hit on a non-active account is a late echo');
  assert.equal(!!r.switched, false, 'the active account is fine, no swap');
  assert.equal(w.mgr.activeName(), 'ana');
  assert.equal(nm(w.mgr.pickBest({ exclude: ['ana', 'cyd'] })), null, 'bob was recorded as limited');
});

test('attribution: otherwise the hit belongs to the active account', async (t) => {
  const w = await setup(t);
  const r = await w.mgr.handleLimit({ at: iso(NOW), resetsAt: iso(NOW + 3 * H), source: 'stopfailure' });
  assert.equal(nm(r.hitAccount), 'ana');
  assert.equal(r.switched, true);
  assert.notEqual(w.mgr.activeName(), 'ana');
});

test('a chat that reports the limit twice in a row (no reset time) does not swap twice', async (t) => {
  const w = await setup(t);
  const first = await w.mgr.handleLimit({ at: iso(NOW), resetsAt: null, source: 'stopfailure' });
  assert.equal(first.switched, true);
  const landed = w.mgr.activeName();
  w.state.now = NOW + 30e3;
  const second = await w.mgr.handleLimit({ at: iso(NOW + 30e3), resetsAt: null, source: 'stopfailure' });
  assert.equal(!!second.duplicate, true);
  assert.equal(!!second.switched, false);
  assert.equal(w.mgr.activeName(), landed, 'still on the account we switched to');
});

test('a failed swap returns next null plus an error, never throws, and leaves the login intact', async (t) => {
  const w = await setup(t);
  const before = readCredText(w.home);
  const file = path.join(w.home, '.credentials.json');
  fs.chmodSync(file, 0o444);
  let r;
  try { r = await w.mgr.handleLimit({ ...hit(), runAccount: 'ana' }); } finally { fs.chmodSync(file, 0o666); }
  assert.equal(nm(r.next), null);
  assert.ok(r.error);
  assert.equal(readCredText(w.home), before);
});

test('handleLimit never throws on junk input', async (t) => {
  const w = await setup(t);
  for (const junk of [undefined, null, {}, { runAccount: 'ghost' }, { at: 'garbage', resetsAt: 'garbage' }, 'x']) {
    await assert.doesNotReject(() => w.mgr.handleLimit(junk));
  }
});
