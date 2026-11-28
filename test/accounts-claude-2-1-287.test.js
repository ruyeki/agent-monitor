// Claude Code 2.1.287 writes claudeAiOauth without accountUuid (identity lives in .claude.json oauthAccount).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runAccountsCli } from '../src/accounts/cli.js';
import { defaults, guardReal } from '../src/accounts/paths.js';
import { readOauthAccount } from '../src/accounts/creds.js';
import { signIn } from '../src/accounts/refresh.js';
import { recordWindows } from '../src/accounts/record.js';
import { loadRegistry, saveRegistry, readUsage } from '../src/accounts/state.js';
import { world, oauth, credsText, tmp, win, secs, NOW, DAY } from './accounts-helpers.js';

const STUB287 = path.join(import.meta.dirname, 'fixtures', 'claude-2-1-287-stub.mjs');
const RYAN = oauth('uuid-ryan');
const LAB = oauth('uuid-lab');
const acct = (uuid, email, org = `org-${uuid}`) => ({ accountUuid: uuid, emailAddress: email, organizationUuid: org });
// 2.1.287's login/refresh shape: no accountUuid, no organizationUuid inside claudeAiOauth.
const bare = (o) => { const { accountUuid, organizationUuid, ...rest } = o; return rest; };
const writeJson = (w, oa) => fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ numStartups: 3, oauthAccount: oa }));

function stubWorld(t, cfg, opts = {}) {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const env = { ...process.env, AM_287_LOG: log, AM_287_STUB: JSON.stringify(cfg) };
  return world(t, { claude: { command: process.execPath, args: [STUB287] }, env, ...opts });
}
const signedIn = { id: 'orders', account: acct('uuid-orders', 'Orders@Persist-AI.com') };

test('add: a login without accountUuid is saved with the identity from .claude.json', async (t) => {
  const w = stubWorld(t, { login: signedIn });
  const r = await w.m.add('orders', { email: 'orders@persist-ai.com' });
  assert.equal(r.accountUuid, 'uuid-orders');
  const v = JSON.parse(w.vault.entries.get('account/orders'));
  assert.equal(v.accountUuid, 'uuid-orders');
  assert.equal(v.organizationUuid, 'org-uuid-orders');
  assert.match(v.refreshToken, /FAKE-orders-refresh/);
  const a = loadRegistry(w.dataDir).accounts.orders;
  assert.equal(a.accountUuid, 'uuid-orders');
  assert.equal(a.email, 'Orders@Persist-AI.com');
});

test('add: no --email still saves, registry email from oauthAccount', async (t) => {
  const w = stubWorld(t, { login: signedIn });
  assert.equal((await w.m.add('orders')).email, 'Orders@Persist-AI.com');
});

test('add: signing in as another email refuses, names the signed-in email, saves nothing', async (t) => {
  const w = stubWorld(t, { login: { id: 'ryan', account: acct('uuid-ryan', 'ryan@x.com') } });
  await assert.rejects(w.m.add('orders', { email: 'orders@x.com' }), /signed in as ryan@x\.com, not orders@x\.com; nothing was saved/);
  assert.equal(w.vault.entries.size, 0);
  assert.deepEqual(loadRegistry(w.dataDir).accounts, {});
});

test('add: no tokens or no identity keeps "sign-in did not finish (exit N)"', async (t) => {
  let w = stubWorld(t, { login: signedIn, write: 'none', exit: 1 });
  await assert.rejects(w.m.add('orders'), /sign-in did not finish \(exit 1\)/);
  w = stubWorld(t, { login: { id: 'orders' } });
  await assert.rejects(w.m.add('orders'), /sign-in did not finish \(exit 0\)/);
  assert.equal(w.vault.entries.size, 0);
});

test('add: creds accountUuid and oauthAccount disagreeing is refused', async (t) => {
  const stub = path.join(tmp(t, 'am-stub-'), 'disagree.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs'; import path from 'node:path'; const d = process.env.CLAUDE_CONFIG_DIR;
fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: 'b', accountUuid: 'uuid-1' } }));
fs.writeFileSync(path.join(d, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-2', emailAddress: 'x@x' } }));`);
  await assert.rejects(signIn({ claude: { command: process.execPath, args: [stub] }, spawn: undefined, env: { ...process.env } }), /conflicting account ids/);
});

test('refresh: a refresh that drops accountUuid is saved with it (oauthAccount absent, or for the same account)', async (t) => {
  for (const oauthAccount of [undefined, acct('uuid-lab', 'lab@example.com')]) {
    const w = stubWorld(t, { oauthAccount }, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN });
    await w.m.refresh('lab');
    const v = JSON.parse(w.vault.entries.get('account/lab'));
    assert.equal(v.accountUuid, 'uuid-lab');
    assert.equal(v.organizationUuid, 'org-uuid-lab');
    assert.equal(v.refreshToken, `${LAB.refreshToken}-rotated`);
  }
});

test('refresh: oauthAccount for another account is refused and nothing is saved', async (t) => {
  const w = stubWorld(t, { oauthAccount: acct('uuid-ryan', 'ryan@example.com') }, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN });
  await assert.rejects(w.m.refresh('lab'), /The saved login no longer works/);
  assert.equal(w.vault.entries.get('account/lab'), JSON.stringify(LAB));
});

test('live identity: after a refresh dropped accountUuid, oauthAccount names the account (no lastSwitch)', (t) => {
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: bare(RYAN) });
  writeJson(w, acct('uuid-ryan', 'ryan@example.com'));
  assert.equal(w.m.activeName(), 'ryan');
  assert.equal(w.m.liveReason(), null);
  assert.equal(w.m.list().find((r) => r.name === 'ryan').active, true);
});

test('live identity: with lastSwitch matching, sync-back saves the live login with accountUuid', async (t) => {
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: bare(LAB) });
  const reg = loadRegistry(w.dataDir);
  reg.lastSwitch = { from: 'ryan', to: 'lab', at: new Date(NOW - 1000).toISOString(), reason: 'manual' };
  saveRegistry(w.dataDir, reg);
  writeJson(w, acct('uuid-lab', 'lab@example.com'));
  fs.writeFileSync(w.file, credsText({ ...bare(LAB), refreshToken: 'rotated-FAKE' }, undefined));
  assert.equal(await w.m.syncBack(), true);
  const v = JSON.parse(w.vault.entries.get('account/lab'));
  assert.equal(v.accountUuid, 'uuid-lab');
  assert.equal(v.refreshToken, 'rotated-FAKE');
});

// lastSwitch.to = lab, but oauthAccount still says ryan and the creds lack accountUuid: nobody can tell who is live.
function ambiguous(t) {
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: bare(LAB) });
  const reg = loadRegistry(w.dataDir);
  reg.lastSwitch = { from: 'ryan', to: 'lab', at: new Date(NOW - DAY).toISOString(), reason: 'manual' };
  saveRegistry(w.dataDir, reg);
  writeJson(w, acct('uuid-ryan', 'ryan@example.com'));
  return w;
}

test('ambiguous: syncBack saves nothing, activeName null, list shows the reason', async (t) => {
  const w = ambiguous(t);
  const before = new Map(w.vault.entries);
  assert.equal(await w.m.syncBack(), false);
  assert.deepEqual(new Map(w.vault.entries), before);
  assert.equal(w.m.activeName(), null);
  assert.match(w.m.liveReason(), /no account id.*ryan@example\.com.*switched to "lab".*\/login/);
  const out = [];
  await runAccountsCli(['list'], { dataDir: w.dataDir, home: w.home, claudeJson: path.join(w.home, '.claude.json'), vault: w.vault, out: (s) => out.push(s) });
  assert.ok(out.some((l) => l.startsWith('Live login: unknown account (')));
});

test('ambiguous: use() throws the reason and leaves the live file and the vault unchanged', async (t) => {
  const w = ambiguous(t);
  const file = w.live();
  const before = new Map(w.vault.entries);
  await assert.rejects(w.m.use('ryan'), /cannot tell which account the live login is: .*; not switching/);
  assert.equal(w.live(), file);
  assert.deepEqual(new Map(w.vault.entries), before);
  assert.equal(loadRegistry(w.dataDir).lastSwitch.to, 'lab');
});

test('ambiguous: handleLimit returns next null with the error', async (t) => {
  const w = ambiguous(t);
  const r = await w.m.handleLimit({ runAccount: 'lab', at: NOW, resetsAt: secs(NOW + 3600_000) });
  assert.equal(r.next, null);
  assert.match(r.error, /cannot tell which account/);
});

test('ambiguous: add --current refuses with the reason; no oauthAccount at all is refused too', async (t) => {
  const w = ambiguous(t);
  await assert.rejects(w.m.add('x', { current: true }), /no account id/);
  const n = world(t, { accounts: { ryan: RYAN }, live: bare(RYAN) });
  await assert.rejects(n.m.add('x', { current: true }), /names no account/);
  await assert.rejects(n.m.use('ryan'), /not switching/);
});

test('ambiguous: a statusline reading is not put on the wrong account', (t) => {
  const w = ambiguous(t);
  const got = recordWindows({ dataDir: w.dataDir, home: w.home, reading: { five_hour: win(40, secs(NOW + 3600_000)) }, now: NOW });
  assert.notEqual(got, 'ryan');
  assert.equal(readUsage(w.dataDir, 'ryan').reading, null);
});

test('add --current: a login without accountUuid takes its identity from oauthAccount', async (t) => {
  const w = world(t, { live: bare(RYAN) });
  writeJson(w, acct('uuid-ryan', 'ryan@example.com'));
  const r = await w.m.add('ryan', { current: true });
  assert.equal(r.accountUuid, 'uuid-ryan');
  assert.equal(JSON.parse(w.vault.entries.get('account/ryan')).accountUuid, 'uuid-ryan');
});

test('node --test refuses the real ~/.claude.json, and no code writes .claude.json', () => {
  const real = path.join(os.homedir(), '.claude.json');
  assert.throws(() => guardReal(real), /refusing the real/);
  assert.equal(readOauthAccount(real), null);
  assert.throws(() => defaults({ CLAUDE_CONFIG_DIR: os.homedir(), AGENT_MONITOR_HOME: tmp(null) }), /refusing the real/);
  for (const f of ['creds.js', 'index.js', 'refresh.js', 'record.js']) {
    const src = fs.readFileSync(path.join(import.meta.dirname, '..', 'src', 'accounts', f), 'utf8');
    assert.doesNotMatch(src, /(write|append|rm|unlink)\w*\([^)]*(claudeJson|\.claude\.json)/, f);
  }
});
