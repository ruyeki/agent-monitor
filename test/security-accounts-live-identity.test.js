// White-hat exploit tests for am-stale-logins (report-only). Each test asserts the SAFE behaviour, so it fails while the
// hole is open.
// Fake tokens only (FAKE); temp homes + memoryVault via the repo's own test helpers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { world, oauth, STUB, NOW, win, secs, tmp, readLog } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const LAB = oauth('uuid-lab');
const three = { ryan: RYAN, orders: ORDERS, lab: LAB };
// Claude Code 2.1.287+ login/renewal shape: no accountUuid / organizationUuid in claudeAiOauth.
const bare = (o) => { const { accountUuid, organizationUuid, ...rest } = o; return rest; };
const fresh = (o, tag) => ({ ...o, accessToken: `${o.accessToken}-${tag}`, refreshToken: `${o.refreshToken}-${tag}` });
const setOa = (w, uuid) => fs.writeFileSync(path.join(w.home, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: uuid, emailAddress: `${uuid}@x.com`, organizationUuid: `org-${uuid}` } }));
const setCreds = (w, o) => fs.writeFileSync(w.file, JSON.stringify({ claudeAiOauth: o }));
const vaultOf = (w, name) => JSON.parse(w.vault.entries.get(`account/${name}`));
const owner = (tok) => /FAKE-(uuid-[a-z]+)-/.exec(tok)?.[1];

test('EXPLOIT 2: an unreadable/half-written .claude.json turns "uncertain" into the carried account (fail-open)', async (t) => {
  const w = world(t, { accounts: three, live: RYAN });
  setOa(w, 'uuid-ryan');
  await w.m.use('orders');
  setCreds(w, bare(fresh(LAB, 'login')));  // someone signed in as lab (2.1.287 shape)
  setOa(w, 'uuid-lab');
  assert.ok(w.m.liveReason(), 'precondition: uncertain while .claude.json names lab');
  const ordersBefore = vaultOf(w, 'orders').refreshToken;
  fs.writeFileSync(path.join(w.home, '.claude.json'), '{"numStartups": 3, "oauthAcc'); // read mid-write
  const reason = w.m.liveReason();
  const synced = await w.m.syncBack();
  const ordersAfter = vaultOf(w, 'orders').refreshToken;
  console.log(`  liveReason=${reason ? 'set' : 'null'} activeName=${w.m.activeName()} syncBack=${synced}`
    + ` vault[orders] now holds a token of ${owner(ordersAfter)} (was ${owner(ordersBefore)})`);
  assert.ok(reason, 'an unreadable .claude.json must not resolve the uncertainty');
  assert.equal(ordersAfter, ordersBefore, "orders' saved login must not be overwritten with lab's token");
});

test('EXPLOIT 3 (cost): repeated limit events re-spawn the login check with no cooldown while checks keep failing', async (t) => {
  const log = path.join(tmp(t, 'am-log-'), 'stub.log');
  const env = { ...process.env, AM_LOGIN_LOG: log, AM_LOGIN_STUB: JSON.stringify({ write: 'none' }) }; // check fails, not a dead login
  const R = secs(NOW + 2 * 3600_000);
  const usage = { orders: { reading: { five_hour: win(10, R + 3600), seven_day: null } }, lab: { reading: { five_hour: win(50, R + 7200), seven_day: null } } };
  const w = world(t, { accounts: three, live: RYAN, usage, env, claude: { command: process.execPath, args: [STUB] } });
  const hit = { at: new Date(R * 1000).toISOString(), resetsAt: new Date(R * 1000).toISOString(), source: 'stopfailure' };
  for (let i = 0; i < 5; i++) await w.m.handleLimit(hit); // e.g. five StopFailure hook posts / chat retries
  const spawns = readLog(log).length;
  console.log(`  5 limit events -> ${spawns} claude spawns`);
  assert.ok(spawns <= 2, 'a failed check should not be re-run on every event');
});
