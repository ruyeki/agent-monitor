import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { recordStatusline } from '../src/accounts/record.js';
import { readUsage, writeUsage } from '../src/accounts/state.js';
import { world, oauth, win, secs, NOW } from './accounts-helpers.js';

const RYAN = oauth('uuid-ryan');
const ORDERS = oauth('uuid-orders');
const R5 = secs(NOW + 3600_000);
const R7 = secs(NOW + 3 * 86400_000);
const status = (rl, extra = {}) => JSON.stringify({ session_id: 's', model: { id: 'claude-opus' }, ...extra, ...(rl ? { rate_limits: rl } : {}) });
const usageFile = (w, name) => path.join(w.dataDir, 'accounts', `usage-${name}.json`);
const RECORD = pathToFileURL(path.join(import.meta.dirname, '..', 'src', 'accounts', 'record.js')).href;

test('record: the statusline reading goes to the live account', (t) => {
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN });
  const opts = { dataDir: w.dataDir, home: w.home, clock: () => NOW };
  assert.equal(recordStatusline(status({ five_hour: win(15, R5), seven_day: win(37, R7) }), opts), 'ryan');
  assert.deepEqual(readUsage(w.dataDir, 'ryan').reading, { five_hour: win(15, R5), seven_day: win(37, R7), at: new Date(NOW).toISOString() });
  assert.equal(fs.existsSync(usageFile(w, 'orders')), false);
});

test('record: a reset time stored on another account attributes the reading to it', (t) => {
  const w = world(t, { accounts: { ryan: RYAN, orders: ORDERS }, live: RYAN });
  writeUsage(w.dataDir, 'orders', { reading: { five_hour: win(40, R5 + 600), seven_day: null, at: 'x' }, limit: null });
  const r = recordStatusline(status({ five_hour: win(55, R5 + 600) }), { dataDir: w.dataDir, home: w.home, clock: () => NOW });
  assert.equal(r, 'orders', 'an old session still on orders');
  assert.equal(readUsage(w.dataDir, 'orders').reading.five_hour.used_percentage, 55);
  assert.equal(fs.existsSync(usageFile(w, 'ryan')), false);
});

test('record: an absent window keeps the stored one; an unchanged reading is not written; no rate_limits = no write', (t) => {
  const w = world(t, { accounts: { ryan: RYAN }, live: RYAN });
  const time = { now: NOW };
  const opts = { dataDir: w.dataDir, home: w.home, clock: () => time.now };
  recordStatusline(status({ five_hour: win(15, R5), seven_day: win(37, R7) }), opts);
  time.now += 60_000;
  recordStatusline(status({ five_hour: win(20, R5) }), opts);
  assert.deepEqual(readUsage(w.dataDir, 'ryan').reading, { five_hour: win(20, R5), seven_day: win(37, R7), at: new Date(time.now).toISOString() });
  const at = readUsage(w.dataDir, 'ryan').reading.at;
  time.now += 60_000;
  recordStatusline(status({ five_hour: win(20, R5), seven_day: win(37, R7) }), opts);
  assert.equal(readUsage(w.dataDir, 'ryan').reading.at, at, 'unchanged: not written');

  const w2 = world(t, { accounts: { ryan: RYAN }, live: RYAN });
  const o2 = { dataDir: w2.dataDir, home: w2.home, clock: () => NOW };
  assert.equal(recordStatusline(status(null), o2), null);
  assert.equal(recordStatusline(status({ five_hour: { used_percentage: 'x' } }), o2), null);
  assert.equal(recordStatusline(status({}), o2), null);
  assert.equal(fs.existsSync(usageFile(w2, 'ryan')), false);
});

test('record: junk input, no accounts or an unknown live login never throw and write nothing', (t) => {
  const w = world(t, { accounts: { ryan: RYAN }, live: oauth('uuid-unknown') });
  const opts = { dataDir: w.dataDir, home: w.home, clock: () => NOW };
  for (const raw of ['', 'not json', 'null', '[]', '{"rate_limits":7}']) assert.equal(recordStatusline(raw, opts), null, raw);
  assert.equal(recordStatusline(status({ five_hour: win(1, R5) }), opts), null, 'no account is live');
  const empty = world(t, { live: RYAN });
  assert.equal(recordStatusline(status({ five_hour: win(1, R5) }), { dataDir: empty.dataDir, home: empty.home }), null);
  assert.equal(fs.existsSync(path.join(empty.dataDir, 'accounts')), false);
});

function runMain(w, input, args = []) {
  const env = { ...process.env, AGENT_MONITOR_HOME: w.dataDir, AGENT_MONITOR_CLAUDE_HOME: w.home, AGENT_MONITOR_VAULT_PREFIX: 'agent-monitor-test-rec/' };
  return spawnSync(process.execPath, ['--input-type=module', '-e', `import { main } from '${RECORD}'; await main(process.argv.slice(1));`, '--', ...args], { input, env, windowsHide: true });
}

test('record main: stdin passes through byte-identical, then the reading is recorded; --quiet prints nothing; exit 0', (t) => {
  const w = world(t, { accounts: { ryan: RYAN }, live: RYAN });
  const input = Buffer.from(`${status({ five_hour: win(15, R5) }, { cwd: 'C:\\Users\\r\\café ✓' })}\r\n`, 'utf8');
  const r = runMain(w, input);
  assert.equal(r.status, 0);
  assert.ok(Buffer.compare(r.stdout, input) === 0, 'byte-identical passthrough');
  assert.equal(readUsage(w.dataDir, 'ryan').reading.five_hour.used_percentage, 15);

  const q = runMain(w, Buffer.from(status({ five_hour: win(25, R5) })), ['--quiet']);
  assert.equal(q.status, 0);
  assert.equal(q.stdout.length, 0);
  assert.equal(readUsage(w.dataDir, 'ryan').reading.five_hour.used_percentage, 25);

  const junk = runMain(w, Buffer.from('\u0000not json'));
  assert.equal(junk.status, 0);
  assert.equal(junk.stdout.toString(), '\u0000not json');
  assert.equal(runMain(w, Buffer.alloc(0)).status, 0);
});
