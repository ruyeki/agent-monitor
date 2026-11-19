// AC3 + AC4 through the server: tracked runs resume on the best account before Codex; chats switch the login.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  world, boot, cred, writeCred, readCred, readCredText, reading, NOW, H, iso, until, sleep, nm,
} from './holdout-accounts-helpers.js';

// The server's limit hook uses the real clock, so these worlds use it too.
const real = () => Date.now();
async function rig(t, { accounts = ['ana', 'bob', 'cyd'], active = 'ana', noAccountsOpt = false } = {}) {
  const w = await world(t, { accounts, active, clock: real });
  const notes = [];
  const app = await boot({ accountsOpt: noAccountsOpt ? null : { manager: w.mgr, notify: (...a) => notes.push(JSON.stringify(a)) } });
  t.after(() => app.close());
  let n = 0;
  const run = async (title = 'R') => { const s = `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`; const id = await app.startRun(`${title} ${n}`, { repo: 'repoA' }); await app.link(s, id); return { id, s }; };
  return { w, app, notes, run };
}
// readings use windows that end at times no hook reset can equal (attribution matches resets exactly)
const fut = (h) => Math.floor((Date.now() + h * H) / 1000);
const text = (d) => JSON.stringify(d);
const lim = (w, name, hours = 4) => w.mgr.recordLimit(name, { at: iso(Date.now() - H), resetsAt: iso(Date.now() + hours * H) });

test('tracked run: limit on ana resumes the SAME session on the account with the most left, not Codex', async (t) => {
  const { w, app, run } = await rig(t);
  w.mgr.recordReading('bob', reading(80, 10, { fiveReset: fut(5.01), sevenReset: fut(48) })); // left 20
  w.mgr.recordReading('cyd', reading(30, 30, { fiveReset: fut(5.02), sevenReset: fut(49) })); // left 70
  const { id, s } = await run();
  assert.equal((await app.limit(s)).status, 200);
  const call = await until(() => app.claudeCalls()[0]);
  assert.ok(call, 'claude was started for the resume');
  const i = call.argv.indexOf('--resume');
  assert.ok(i >= 0 && call.argv[i + 1] === s, 'resumes the run\'s own session');
  assert.equal(w.mgr.activeName(), 'cyd');
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-cyd');
  const d = await app.detail(id);
  assert.equal(d.run.provider ?? 'claude', 'claude', 'the run stays on Claude');
  assert.match(text(d), /cyd/, 'the timeline names the account that took over');
  await sleep(1500);
  assert.equal(app.codexCalls().length, 0, 'Codex was never started');
});

test('tracked run: the account that just hit is never chosen even when it has the most left', async (t) => {
  const { w, app, run } = await rig(t, { accounts: ['ana', 'bob'] });
  w.mgr.recordReading('bob', reading(95, 0, { fiveReset: fut(5.01), sevenReset: fut(48) })); // left 5, ana has no reading = 100
  const { s } = await run();
  await app.limit(s);
  assert.ok(await until(() => app.claudeCalls()[0]));
  assert.equal(w.mgr.activeName(), 'bob');
});

test('tracked run: every account out means Codex, and Claude is not started', async (t) => {
  const { w, app, run } = await rig(t);
  lim(w, 'bob'); lim(w, 'cyd');
  const { id, s } = await run();
  await app.limit(s);
  assert.ok(await until(() => app.codexCalls()[0]), 'Codex took the run');
  const d = await app.detail(id);
  assert.equal(d.run.provider, 'codex');
  assert.equal(app.claudeCalls().length, 0);
  assert.equal(w.mgr.activeName(), 'ana', 'no swap when nobody is available');
});

test('tracked run: a failed swap falls back to Codex rather than losing the run', async (t) => {
  const { w, app, run } = await rig(t);
  const file = `${w.home}\\.credentials.json`;
  const before = readCredText(w.home);
  fs.chmodSync(file, 0o444);
  t.after(() => { try { fs.chmodSync(file, 0o666); } catch { /* gone */ } });
  const { id, s } = await run();
  await app.limit(s);
  assert.ok(await until(() => app.codexCalls()[0], 20000), 'Codex took the run');
  assert.equal(app.claudeCalls().length, 0);
  assert.equal(readCredText(w.home), before);
  assert.equal((await app.detail(id)).run.provider, 'codex');
});

test('tracked run: the same limit reported twice resumes once', async (t) => {
  const { app, run, w } = await rig(t);
  const { s } = await run();
  await app.limit(s); await app.limit(s); await app.limit(s);
  assert.ok(await until(() => app.claudeCalls()[0]));
  await sleep(1500);
  assert.equal(app.claudeCalls().length, 1, 'one resume only');
  assert.equal(app.codexCalls().length, 0);
});

test('no accounts registered: exactly today\'s behaviour, the run goes to Codex', async (t) => {
  const { app, run } = await rig(t, { accounts: [] });
  const { id, s } = await run();
  await app.limit(s);
  assert.ok(await until(() => app.codexCalls()[0]));
  assert.equal((await app.detail(id)).run.provider, 'codex');
  assert.equal(app.claudeCalls().length, 0);
});

test('chat (session not on any run): rate_limit switches the active login to the best account and tells Ryan to type continue', async (t) => {
  const { w, app, notes } = await rig(t);
  w.mgr.recordReading('bob', reading(60, 10, { fiveReset: fut(5.01), sevenReset: fut(48) }));
  const r = await app.limit('a-chat-session');
  assert.equal(r.status, 200);
  assert.ok(await until(() => w.mgr.activeName() !== 'ana'), 'login switched');
  assert.equal(w.mgr.activeName(), 'cyd', 'cyd has no reading = most left');
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-cyd');
  assert.ok(await until(() => notes.length > 0), 'Ryan was notified');
  assert.match(notes.join('\n'), /continue/i);
  assert.equal(app.claudeCalls().length, 0, 'a chat is not resumed by Agent Monitor');
  assert.equal(app.codexCalls().length, 0);
});

test('chat: the hook still answers immediately, even though the swap takes a moment', async (t) => {
  const { app } = await rig(t);
  const t0 = Date.now();
  const r = await app.limit('chat-fast');
  assert.equal(r.status, 200);
  assert.ok(Date.now() - t0 < 1500, 'hook answered fast');
  assert.deepEqual(r.json ?? {}, {}, 'no decision output for a StopFailure');
});

test('chat: when every other account is out, the login is left alone', async (t) => {
  const { w, app } = await rig(t);
  lim(w, 'bob'); lim(w, 'cyd');
  const before = readCredText(w.home);
  await app.limit('chat-nowhere');
  await sleep(2500);
  assert.equal(readCredText(w.home), before);
  assert.equal(w.mgr.activeName(), 'ana');
});

test('chat: a second rate_limit from the same chat right after the switch does not switch again', async (t) => {
  const { w, app } = await rig(t);
  await app.limit('chat-dup', { error_details: {} });
  assert.ok(await until(() => w.mgr.activeName() !== 'ana'));
  const landed = w.mgr.activeName();
  await app.limit('chat-dup', { error_details: {} });
  await sleep(2500);
  assert.equal(w.mgr.activeName(), landed);
});

test('non rate_limit StopFailure errors never touch the login', async (t) => {
  const { w, app, run } = await rig(t);
  const before = readCredText(w.home);
  const { s } = await run();
  for (const error of ['overloaded', 'authentication_failed', 'server_error', 'Rate_Limit']) { await app.limit(s, { error }); await app.limit('chat-x', { error }); }
  await sleep(1500);
  assert.equal(readCredText(w.home), before);
  assert.equal(app.claudeCalls().length, 0);
  assert.equal(app.codexCalls().length, 0);
});
