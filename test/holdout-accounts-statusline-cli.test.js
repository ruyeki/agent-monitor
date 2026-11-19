// AC1 (list/use CLI) + AC2 (statusline recording).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { world, cred, writeCred, readCred, readCredText, reading, readUsageFile, load, tmp, NOW, H, sec, TOKEN_MARK, newPrefix, vaultWipe, filesWithTokens, fileUrl } from './holdout-accounts-helpers.js';

const clk = (w) => () => w.state.now;
const raw = (five, seven) => JSON.stringify({ session_id: 's', model: { id: 'm' }, rate_limits: { five_hour: five, seven_day: seven } });

test('recordStatusline: records the statusline rate_limits against the ACTIVE account', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana' });
  const { recordStatusline } = await load('src/accounts/record.js');
  await recordStatusline(raw({ used_percentage: 42, resets_at: sec(NOW + 2 * H) }, { used_percentage: 61.5, resets_at: sec(NOW + 40 * H) }), { dataDir: w.dataDir, home: w.home, clock: clk(w) });
  const u = readUsageFile(w.dataDir, 'ana');
  assert.equal(u.reading.five_hour.used_percentage, 42);
  assert.equal(u.reading.five_hour.resets_at, sec(NOW + 2 * H));
  assert.equal(u.reading.seven_day.used_percentage, 61.5);
  assert.ok(!fs.existsSync(path.join(w.dataDir, 'accounts', 'usage-bob.json')) || readUsageFile(w.dataDir, 'bob').reading == null);
  assert.deepEqual(filesWithTokens(w.dataDir), []);
});

test('recordStatusline: a window may be missing; usage left then ignores it', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana' });
  const { recordStatusline } = await load('src/accounts/record.js');
  await recordStatusline(raw({ used_percentage: 99, resets_at: sec(NOW + 2 * H) }, undefined), { dataDir: w.dataDir, home: w.home, clock: clk(w) });
  assert.equal(readUsageFile(w.dataDir, 'ana').reading.five_hour.used_percentage, 99);
  await recordStatusline(raw(undefined, { used_percentage: 10, resets_at: sec(NOW + 2 * H) }), { dataDir: w.dataDir, home: w.home, clock: clk(w) });
  const r = readUsageFile(w.dataDir, 'ana').reading;
  assert.equal(r.seven_day.used_percentage, 10);
});

test('recordStatusline: a reading whose 5h reset equals another account\'s stored window is filed under that account', async (t) => {
  const w = await world(t, { accounts: ['ana', 'bob'], active: 'ana' });
  const R = sec(NOW + 90 * 60e3);
  w.mgr.recordReading('bob', reading(20, 20, { fiveReset: R }));
  const { recordStatusline } = await load('src/accounts/record.js');
  await recordStatusline(raw({ used_percentage: 33, resets_at: R }, { used_percentage: 5, resets_at: sec(NOW + 40 * H) }), { dataDir: w.dataDir, home: w.home, clock: clk(w) });
  assert.equal(readUsageFile(w.dataDir, 'bob').reading.five_hour.used_percentage, 33);
  const a = (() => { try { return readUsageFile(w.dataDir, 'ana').reading; } catch { return null; } })();
  assert.ok(a == null || a.five_hour == null || a.five_hour.used_percentage !== 33, 'not recorded against the active account');
});

test('recordStatusline never throws: junk input, no accounts, no login file, unknown login', async (t) => {
  const { recordStatusline } = await load('src/accounts/record.js');
  const w = await world(t, { accounts: ['ana'], active: 'ana' });
  for (const j of ['', 'not json', '{}', 'null', '[]', raw('x', 5), raw({ used_percentage: 'NaN' }, {}), JSON.stringify({ rate_limits: 7 })]) {
    await assert.doesNotReject(async () => recordStatusline(j, { dataDir: w.dataDir, home: w.home, clock: clk(w) }));
  }
  fs.rmSync(path.join(w.home, '.credentials.json'));
  await assert.doesNotReject(async () => recordStatusline(raw({ used_percentage: 1, resets_at: sec(NOW + H) }, {}), { dataDir: w.dataDir, home: w.home, clock: clk(w) }));
  writeCred(w.home, cred('stranger'));
  await assert.doesNotReject(async () => recordStatusline(raw({ used_percentage: 1, resets_at: sec(NOW + H) }, {}), { dataDir: w.dataDir, home: w.home, clock: clk(w) }));
  const empty = tmp('amv-empty-');
  await assert.doesNotReject(async () => recordStatusline(raw({ used_percentage: 1, resets_at: sec(NOW + H) }, {}), { dataDir: empty, home: empty, clock: clk(w) }));
  fs.rmSync(empty, { recursive: true, force: true });
});

function runMain(env, stdin, args = ['statusline-record']) {
  const code = `import(${JSON.stringify(fileUrl('src/accounts/record.js'))}).then((m) => m.main(${JSON.stringify(args)})).then(() => process.exit(0))`;
  return spawnSync(process.execPath, ['-e', code], { input: stdin, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 15000, windowsHide: true });
}

test('statusline-record main: passes stdin through to stdout, records, always exits 0; --quiet prints nothing', async (t) => {
  const w = await world(t, { accounts: ['ana'], active: 'ana' });
  const env = { AGENT_MONITOR_HOME: w.dataDir, AGENT_MONITOR_CLAUDE_HOME: w.home, AGENT_MONITOR_VAULT_PREFIX: w.prefix };
  const input = raw({ used_percentage: 12, resets_at: sec(Date.now() + 2 * H) }, { used_percentage: 3, resets_at: sec(Date.now() + 40 * H) });
  const a = runMain(env, input);
  assert.equal(a.status, 0);
  assert.equal(a.stdout, input, 'stdin passed through untouched');
  assert.equal(readUsageFile(w.dataDir, 'ana').reading.five_hour.used_percentage, 12);
  const b = runMain(env, input, ['statusline-record', '--quiet']);
  assert.equal(b.status, 0);
  assert.equal(b.stdout, '');
  const c = runMain(env, 'garbage that is not json');
  assert.equal(c.status, 0);
  assert.equal(c.stdout, 'garbage that is not json');
  const d = runMain({ ...env, AGENT_MONITOR_HOME: path.join(w.dataDir, 'does', 'not', 'exist') }, input);
  assert.equal(d.status, 0);
});

// ---- CLI ----
async function cliWorld(t, o) {
  const w = await world(t, o);
  const { runAccountsCli } = await load('src/accounts/cli.js');
  const buf = { out: '', err: '' };
  const mk = (k) => Object.assign((s) => { buf[k] += `${String(s)}
`; return true; }, { write: (s) => { buf[k] += String(s); return true; } });
  let prefix = null;
  // the convention for argv (with or without the leading "accounts") is the worker's choice: detect it once
  const run = async (...args) => {
    buf.out = ''; buf.err = '';
    const go = (a) => runAccountsCli(a, { dataDir: w.dataDir, home: w.home, vault: w.vault, claude: w.fakeClaude, out: mk('out'), err: mk('err') });
    let code = await go(prefix ? ['accounts', ...args] : args);
    if (prefix === null && code !== 0 && args[0] === 'list') { prefix = true; code = await go(['accounts', ...args]); } else if (prefix === null) prefix = false;
    return code;
  };
  return { w, run, buf };
}

test('cli list: shows every account with its percentages and marks the active one; never prints tokens', async (t) => {
  const { w, run, buf } = await cliWorld(t, { accounts: ['ana', 'bob'], active: 'ana' });
  const f = (h) => Math.floor((Date.now() + h * H) / 1000);
  w.mgr.recordReading('ana', reading(41, 73, { fiveReset: f(2), sevenReset: f(40) }));
  w.mgr.recordReading('bob', reading(8, 12, { fiveReset: f(3), sevenReset: f(41) }));
  const code = await run('list');
  assert.equal(code, 0);
  const text = buf.out + buf.err;
  if (process.env.AMV_DEBUG) console.error(JSON.stringify(text));
  for (const n of ['ana', 'bob']) assert.match(text, new RegExp(n));
  for (const n of ['41', '73', '8', '12']) assert.match(text, new RegExp(`\\b${n}\\b`));
  assert.match(text, /left|remain/i);
  assert.ok(!text.includes(TOKEN_MARK), 'no token values in output');
  const lines = text.split('\n');
  const mark = lines.filter((l) => /active|\*|>|current/i.test(l));
  assert.ok(mark.some((l) => /ana/.test(l)) && !mark.some((l) => /bob/.test(l)), 'only ana is marked active');
});

test('cli list with no accounts exits 0 and says so', async (t) => {
  const { run, buf } = await cliWorld(t, { accounts: [] });
  assert.equal(await run('list'), 0);
  assert.ok((buf.out + buf.err).trim().length > 0);
});

test('cli use <name> swaps by hand; an unknown name or missing argument fails without touching the login', async (t) => {
  const { w, run, buf } = await cliWorld(t, { accounts: ['ana', 'bob'], active: 'ana' });
  const before = readCredText(w.home);
  assert.notEqual(await run('use', 'nope'), 0);
  assert.notEqual(await run('use'), 0);
  assert.equal(readCredText(w.home), before);
  assert.equal(await run('use', 'bob'), 0);
  assert.equal(readCred(w.home).claudeAiOauth.accountUuid, 'uuid-bob');
  assert.ok(!(buf.out + buf.err).includes(TOKEN_MARK));
});

test('cli: unknown subcommand and a bad account name fail with a non-zero code', async (t) => {
  const { run, w } = await cliWorld(t, { accounts: ['ana'], active: 'ana' });
  assert.notEqual(await run('frobnicate'), 0);
  assert.notEqual(await run('add', 'Bad Name'), 0);
  assert.equal(Object.keys(JSON.parse(fs.readFileSync(path.join(w.dataDir, 'accounts', 'registry.json'), 'utf8')).accounts).length, 1);
});
