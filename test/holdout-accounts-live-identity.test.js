import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { liveIdentity } from '../src/accounts/creds.js';
import { loadRegistry, saveRegistry } from '../src/accounts/state.js';
import { oauth, credsText, bare, acct, U, tmp } from './holdout-accounts-live-helpers.js';

const accounts = () => Object.fromEntries(['ryan', 'lab', 'orders'].map((n) => [n, { accountUuid: U(n), email: `${n}@example.com`, savedAt: 'x' }]));
const live = (c, oa, at = '2026-11-20T00:00:00.000Z') => ({ accountUuid: U(c), oauthAccount: oa ? U(oa) : null, organizationUuid: `org-${U(c)}`, at });
function setup(t, { tokens = oauth(U('lab')), oa, noCreds = false, reg }) {
  const home = tmp(t, 'am-id-');
  if (!noCreds) fs.writeFileSync(path.join(home, '.credentials.json'), credsText(tokens, tokens.organizationUuid));
  const claudeJson = path.join(home, '.claude.json');
  if (oa) fs.writeFileSync(claudeJson, JSON.stringify({ oauthAccount: acct(oa) }));
  return { home, claudeJson, reg };
}
const R = (extra) => ({ accounts: accounts(), lastSwitch: { from: 'ryan', to: 'lab', at: '2026-11-19T00:00:00.000Z', reason: 'manual' }, ...extra });

test('AC2: after an Agent Monitor swap, a renewal that drops accountUuid is still the carried account while .claude.json lags', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'ryan', reg: R({ live: live('lab', 'ryan') }) }));
  assert.equal(r.accountUuid, U('lab'));
  assert.equal(r.reason, null);
  assert.equal(r.oauth.accountUuid, U('lab'));
  assert.equal(r.oauth.organizationUuid, `org-${U('lab')}`);
});

test('AC2: no time limit on the lag (weeks later it is still the carried account)', (t) => {
  const old = live('lab', 'ryan', '2026-10-01T00:00:00.000Z');
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'ryan', reg: R({ live: old }) }));
  assert.equal(r.accountUuid, U('lab'));
});

test('AC2: .claude.json naming the carried account itself keeps the carried account', (t) => {
  assert.equal(liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'lab', reg: R({ live: live('lab', 'ryan') }) })).accountUuid, U('lab'));
});

test('AC2: carried recorded with no oauthAccount and .claude.json still without one -> still the carried account', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: null, reg: R({ live: live('lab', null) }) }));
  assert.equal(r.accountUuid, U('lab'));
  assert.equal(r.reason, null);
});

test('AC3: carried recorded with an oauthAccount but .claude.json now has none (missing or unreadable) -> uncertain', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: null, reg: R({ live: live('lab', 'ryan') }) }));
  assert.equal(r.oauth, null);
  assert.equal(r.accountUuid, null);
  assert.ok(r.reason);
});

test('AC3: .claude.json changed to another account since it was recorded -> uncertain, names both, tells Ryan to /login', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('lab'))), oa: 'orders', reg: R({ live: live('lab', 'ryan') }) }));
  assert.equal(r.oauth, null);
  assert.equal(r.accountUuid, null);
  assert.match(r.reason, /orders@example\.com/);
  assert.match(r.reason, /lab/);
  assert.match(r.reason, /\/login/);
});

test('AC1: the creds own accountUuid wins over a stale lastSwitch and over the carried account', (t) => {
  const r = liveIdentity(setup(t, { tokens: oauth(U('orders')), oa: 'ryan', reg: R({ live: live('lab', 'ryan') }) }));
  assert.equal(r.accountUuid, U('orders'));
  assert.equal(r.reason, null);
});

test('AC1: a manual login recorded as live is trusted although lastSwitch names another account and .claude.json lags', (t) => {
  const r = liveIdentity(setup(t, { tokens: bare(oauth(U('orders'))), oa: 'ryan', reg: R({ live: live('orders', 'ryan') }) }));
  assert.equal(r.accountUuid, U('orders'));
  assert.equal(r.reason, null);
});

test('no tokens -> no live login, whatever is carried', (t) => {
  const r = liveIdentity(setup(t, { noCreds: true, oa: 'ryan', reg: R({ live: live('lab', 'ryan') }) }));
  assert.deepEqual(r, { oauth: null, accountUuid: null, email: null, reason: null });
});

test('an unregistered carried account is identified by its uuid (no name needed)', (t) => {
  const reg = R({ live: { accountUuid: 'uuid-stranger', oauthAccount: U('ryan'), organizationUuid: 'org-s', at: 'x' } });
  const r = liveIdentity(setup(t, { tokens: bare(oauth('uuid-stranger')), oa: 'ryan', reg }));
  assert.equal(r.accountUuid, 'uuid-stranger');
  assert.equal(r.reason, null);
});

test('registry round trip keeps the live field; a registry without it loads without one', (t) => {
  const dir = tmp(t, 'am-reg-');
  const reg = { accounts: accounts(), lastSwitch: null, live: live('lab', 'ryan') };
  saveRegistry(dir, reg);
  assert.deepEqual(loadRegistry(dir).live, reg.live);
  const dir2 = tmp(t, 'am-reg-');
  saveRegistry(dir2, { accounts: accounts(), lastSwitch: null });
  assert.equal(loadRegistry(dir2).live ?? null, null);
});
