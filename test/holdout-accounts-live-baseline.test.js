// What the account code does today and must keep doing (legacy registries, success shapes, creds-uuid identity). Fake logins only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { liveIdentity } from '../src/accounts/creds.js';
import { loadRegistry, saveRegistry } from '../src/accounts/state.js';
import { world, oauth, credsText, tmp, win, secs, NOW, DAY } from './accounts-helpers.js';

const bare = (o) => { const { accountUuid, organizationUuid, ...rest } = o; return rest; };
const U = (n) => `uuid-${n}`;
const acct = (n) => ({ accountUuid: U(n), emailAddress: `${n}@example.com`, organizationUuid: `org-${U(n)}` });
const accounts = () => Object.fromEntries(['ryan', 'lab'].map((n) => [n, { accountUuid: U(n), email: `${n}@example.com`, savedAt: 'x' }]));
function setup(t, { tokens, oa, reg }) {
  const home = tmp(t, 'am-bl-');
  if (tokens) fs.writeFileSync(path.join(home, '.credentials.json'), credsText(tokens, tokens.organizationUuid));
  const claudeJson = path.join(home, '.claude.json');
  if (oa) fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: acct(oa) }));
  return { home, claudeJson, reg };
}
const sw = (to) => ({ from: 'ryan', to, at: '2026-11-19T00:00:00.000Z', reason: 'manual' });

test('legacy: no tokens -> no live login', (t) => {
  assert.deepEqual(liveIdentity(setup(t, { oa: 'ryan', reg: { accounts: accounts(), lastSwitch: null } })), { oauth: null, accountUuid: null, email: null, reason: null });
});
test('legacy: the creds accountUuid is trusted', (t) => {
  const r = liveIdentity(setup(t, { tokens: oauth(U('lab')), oa: 'ryan', reg: { accounts: accounts(), lastSwitch: sw('ryan') } }));
  assert.equal(r.accountUuid, U('lab'));
  assert.equal(r.reason, null);
});
test('legacy: no accountUuid, no lastSwitch -> .claude.json names the account', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('ryan'))), oa: 'ryan', reg: { accounts: accounts(), lastSwitch: null } }));
  assert.equal(r.accountUuid, U('ryan'));
  assert.equal(r.email, 'ryan@example.com');
  assert.equal(r.oauth.accountUuid, U('ryan'));
});
test('legacy: no accountUuid, lastSwitch to lab, .claude.json names lab -> lab', (t) => {
  assert.equal(liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'lab', reg: { accounts: accounts(), lastSwitch: sw('lab') } })).accountUuid, U('lab'));
});
test('legacy: no accountUuid, lastSwitch to lab, .claude.json names ryan -> uncertain, reason mentions both', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'ryan', reg: { accounts: accounts(), lastSwitch: sw('lab') } }));
  assert.equal(r.oauth, null);
  assert.equal(r.accountUuid, null);
  assert.match(r.reason, /no account id/);
  assert.match(r.reason, /ryan@example\.com/);
  assert.match(r.reason, /"lab"/);
});
test('legacy: no accountUuid and no .claude.json after a switch -> uncertain', (t) => {
  assert.ok(liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), reg: { accounts: accounts(), lastSwitch: sw('lab') } })).reason);
});
test('a registry round trip without a live field keeps accounts and lastSwitch', (t) => {
  const dir = tmp(t, 'am-bl-reg-');
  saveRegistry(dir, { accounts: accounts(), lastSwitch: sw('lab') });
  const r = loadRegistry(dir);
  assert.deepEqual(r.accounts, accounts());
  assert.deepEqual(r.lastSwitch, sw('lab'));
});

test('swap: use() puts the saved login live, saves the old live one, records lastSwitch', async (t) => {
  const RYAN = oauth(U('ryan'));
  const LAB = oauth(U('lab'));
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN });
  const r = await w.m.use('lab');
  assert.deepEqual(r, { from: 'ryan', to: 'lab', switched: true });
  assert.equal(JSON.parse(w.live()).claudeAiOauth.refreshToken, LAB.refreshToken);
  assert.equal(loadRegistry(w.dataDir).lastSwitch.to, 'lab');
  assert.equal(w.m.activeName(), 'lab');
});

test('swap: a creds-uuid live login is synced back to its account (sync-back baseline)', async (t) => {
  const RYAN = oauth(U('ryan'));
  const w = world(t, { accounts: { ryan: RYAN }, live: RYAN });
  assert.equal(await w.m.syncBack(), true, 'a new manager has not seen the live login yet');
  assert.equal(await w.m.syncBack(), false);
  fs.writeFileSync(w.file, credsText({ ...RYAN, refreshToken: 'rotated-FAKE' }));
  assert.equal(await w.m.syncBack(), true);
  assert.equal(JSON.parse(w.vault.entries.get('account/ryan')).refreshToken, 'rotated-FAKE');
  assert.equal(await w.m.syncBack(), false);
});

test('handleLimit success shape is unchanged (active hits, next best, switched)', async (t) => {
  const R = secs(NOW + 2 * 3600_000);
  const at = new Date(NOW).toISOString();
  const RYAN = oauth(U('ryan'));
  const LAB = oauth(U('lab'));
  // a stub that refreshes (so this also passes once a pre-switch check exists)
  const stub = path.join(tmp(t, 'am-bl-stub-'), 'ok.mjs');
  fs.writeFileSync(stub, `import fs from 'node:fs'; import path from 'node:path'; for await (const c of process.stdin) void c;
const f = path.join(process.env.CLAUDE_CONFIG_DIR, '.credentials.json'); const s = JSON.parse(fs.readFileSync(f, 'utf8')).claudeAiOauth;
fs.writeFileSync(f, JSON.stringify({ claudeAiOauth: { ...s, refreshToken: s.refreshToken + '-rot', expiresAt: Date.now() + 3600000 } }));
process.stdout.write(JSON.stringify({ type: 'result', is_error: false }) + '\\n');`);
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN, usage: { lab: { reading: { five_hour: win(10, R + 3600), seven_day: null } } }, claude: { command: process.execPath, args: [stub] } });
  const r = await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' });
  assert.deepEqual(r, { hitAccount: 'ryan', next: 'lab', switched: true, duplicate: false });
  assert.equal(w.m.activeName(), 'lab');
});

test('handleLimit with nobody else available: next null, no error key', async (t) => {
  const R = secs(NOW + 2 * 3600_000);
  const at = new Date(NOW).toISOString();
  const RYAN = oauth(U('ryan'));
  const LAB = oauth(U('lab'));
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN, usage: { lab: { reading: null, limit: { at, resetsAt: secs(NOW + DAY) } } } });
  assert.deepEqual(await w.m.handleLimit({ at, resetsAt: R, source: 'stopfailure' }), { hitAccount: 'ryan', next: null, switched: false, duplicate: false });
});

test('refresh: the live account is refused; an unknown name is refused; no claude -> a plain error', async (t) => {
  const RYAN = oauth(U('ryan'));
  const LAB = oauth(U('lab'));
  const w = world(t, { accounts: { ryan: RYAN, lab: LAB }, live: RYAN, claude: null });
  await assert.rejects(w.m.refresh('ryan'), /is the live login/);
  await assert.rejects(w.m.refresh('nobody'), /no account named/);
  await assert.rejects(w.m.refresh('lab'), /Claude Code was not found/);
  assert.equal(w.m.list().find((a) => a.name === 'lab').saved, true, 'a spawn-level failure does not mark the account');
});
