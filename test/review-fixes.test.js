// Review fix round 3 (server): ledger masking/result capture, hooks, context windows, ledger fallback, indexes, live reading folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { redact, ledgerResult, classifyChanges, SHELL_TOOLS } from '../src/ledger.js';
import { windowFor } from '../src/context.js';
import { openUsage } from '../src/usage.js';
import { liveReading } from '../src/accounts/refresh.js';
import { tmp } from './helpers.js';
import { boot } from './holdout-helpers.js';

const { DatabaseSync } = await import('node:sqlite');

function setup() {
  const store = openStore(tmp('am-rf-'));
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  const ev = (hook_event_name, extra = {}) => hooks.handle({ session_id: 'cs', cwd: '/x', hook_event_name, ...extra });
  return { store, hooks, ev, id: run.id };
}

test('redact stays linear on long runs of the shapes each pattern looks for', () => {
  const shapes = ['a.a.', 'http://a:', `authorization${' '.repeat(9)}`, `x-token${' '.repeat(9)}`, 'mysql ', 'sshpass -p ', '$a_password ', '"password" ', 'PASSWORD=" ', '-u a:'];
  for (const sh of shapes) {
    const big = sh.repeat(Math.ceil(100_000 / sh.length));
    const t0 = performance.now();
    redact(big);
    assert.ok(performance.now() - t0 < 500, `${sh} took ${Math.round(performance.now() - t0)} ms`);
  }
});

test('redact keeps references and plain words', () => {
  assert.equal(redact('curl -u admin:$PW https://x'), 'curl -u admin:$PW https://x');
  assert.equal(redact('PWD=/home/x ls'), 'PWD=/home/x ls');
  assert.equal(redact('git commit -m "update the token flow"'), 'git commit -m "update the token flow"');
  assert.match(redact('mysql -uroot -pSecret1 app'), /-p\*\*\*/);
});

test('ledgerResult keeps head 300 + tail, exactly max long, marker between', () => {
  const raw = `${'h'.repeat(300)}${'m'.repeat(5000)}[main abc1234] the subject\n 1 file changed, 2 insertions(+)`;
  const r = ledgerResult(raw, 1000);
  assert.equal(r.length, 1000);
  assert.ok(r.startsWith('h'.repeat(300)));
  assert.match(r, /\[\.\.\.\]/);
  assert.match(r, /\[main abc1234\] the subject/);
  assert.equal(ledgerResult('short', 1000), 'short');
});

test('a git commit line past the first 1000 characters of the output is still read by the ledger', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git commit -m x' }, tool_use_id: 'u1' });
  t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_response: { stdout: `${'hook output\n'.repeat(300)}[main abc1234] the subject\n 1 file changed, 2 insertions(+)\n` } });
  const { items } = classifyChanges(t.store.changesOf(t.id));
  assert.match(items[0].title, /abc1234 the subject/);
  t.store.close();
});

test('no result is built for a tool call that got no ledger row', () => {
  const t = setup();
  let touched = false;
  const resp = { get stdout() { touched = true; return 'x'; } };
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: 'u1' });
  t.ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_response: resp });
  assert.equal(touched, false);
  assert.equal(t.store.changesOf(t.id).length, 0);
  t.store.close();
});

test('a Hephaestus status change survives a long description before the status', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'mcp__hephaestus__update_task', tool_input: { task_id: 2289, description: 'd'.repeat(5000), status: 'Done' }, tool_use_id: 'u1' });
  const [row] = t.store.changesOf(t.id);
  assert.equal(row.input, '{"task_id":"2289","status":"Done"}');
  const { items } = classifyChanges([{ ...row, at: 'a' }]);
  assert.equal(items[0].title, 'Set Hephaestus #2289 status');
  assert.deepEqual(items[0].chips, ['Hephaestus', 'Done']);
  t.store.close();
});

test('one SHELL_TOOLS covers the tools the ledger and the hooks both name', () => {
  for (const n of ['Bash', 'PowerShell', 'pwsh', 'exec_command', 'local_shell', 'run_shell_command', 'shell']) assert.ok(SHELL_TOOLS.test(n), n);
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'exec_command', tool_input: { command: 'git push origin main' }, tool_use_id: 'u1' });
  assert.equal(t.store.changesOf(t.id)[0].input, 'git push origin main');
  t.store.close();
});

test('a confirmed parent guess stops re-reading meta.json even when the parent did not change', () => {
  const t = setup();
  const root = tmp('am-proj-');
  const hooks = createHooks(t.store, { projectsDir: root, port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const sub = path.join(root, 'p', 's1', 'subagents', 'agent-a1.jsonl');
  fs.mkdirSync(path.dirname(sub), { recursive: true });
  fs.writeFileSync(sub, '');
  const send = (e, x) => hooks.handle({ session_id: 'cs', cwd: '/x', hook_event_name: e, ...x });
  send('PreToolUse', { tool_name: 'Agent', tool_input: { prompt: 'p' }, tool_use_id: 'toolu_P' });
  send('SubagentStart', { agent_id: 'a1', agent_type: 'x', transcript_path: path.join(root, 'p', 's1.jsonl'), agent_transcript_path: sub });
  assert.equal(t.store.getAgent('a1').parent_agent_id, 'main:cs'); // guessed
  const meta = sub.replace('.jsonl', '.meta.json');
  fs.writeFileSync(meta, JSON.stringify({ toolUseId: 'toolu_P', description: 'd' }));
  hooks.readTokens('a1'); // meta confirms the same parent
  fs.rmSync(meta);
  let reads = 0;
  const orig = fs.readFileSync;
  fs.readFileSync = (...a) => { if (String(a[0]).endsWith('.meta.json')) reads++; return orig(...a); };
  try { hooks.readTokens('a1'); } finally { fs.readFileSync = orig; }
  assert.equal(reads, 0, 'the guess was cleared, so meta.json is not read again');
  t.store.close();
});

test('windowFor matches only at an id boundary and keeps the known windows', () => {
  assert.equal(windowFor('claude-opus-5'), 1_000_000);
  assert.equal(windowFor('claude-opus-5-5'), 1_000_000);
  assert.equal(windowFor('claude-opus-5[1m]'), 1_000_000);
  assert.equal(windowFor('claude-opus-50'), 200_000);
  assert.equal(windowFor('claude-sonnet-50'), 200_000);
  assert.equal(windowFor('claude-haiku-4-5-20251001'), 200_000);
  assert.equal(windowFor('claude-fable-5'), 1_000_000);
});

test('ledger endpoint: activity rows only for runs with no changes rows', async () => {
  const b = await boot({});
  try {
    const run = b.srv.store.startRun({ title: 'R' }).run.id;
    b.srv.store.linkSession('cs', run);
    b.srv.store.addActivity(run, 'main:cs', 'tool', 'Bash', 'git push origin main', 'old1');
    b.srv.store.endActivity(run, 'old1', 'ok');
    let r = await b.api('GET', `/api/runs/${run}/ledger`);
    assert.equal(r.json.items.length, 1);
    b.srv.store.addChange(run, 'main:cs', 'Bash', 'new1', 'git push origin main');
    b.srv.store.addActivity(run, 'main:cs', 'tool', 'Bash', 'git push origin dev', null);
    r = await b.api('GET', `/api/runs/${run}/ledger`);
    assert.equal(r.json.items.length, 1);
  } finally { await b.srv.close(); }
});

test('usage.db has composite indexes for the latest-context lookups', async () => {
  const dir = tmp('am-usage-');
  const u = await openUsage({ dataDir: dir, projectsDir: tmp('am-proj-') });
  u.close();
  const db = new DatabaseSync(path.join(dir, 'usage.db'));
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all().map((r) => r.name);
  db.close();
  assert.ok(names.includes('usage_messages_agent_ts') && names.includes('usage_messages_session_ts'));
});

test('liveReading runs in one stable private folder under the data dir, created once and reused', async () => {
  const dataDir = tmp('am-data-');
  const home = tmp('am-home-');
  const cwds = [];
  const line = JSON.stringify({ type: 'rate_limit_event', rate_limit_info: { rateLimitType: 'five_hour', utilization: 0.1, resetsAt: 1 } });
  const spawn = (cmd, args, o) => {
    cwds.push(o.cwd);
    const c = new EventEmitter();
    c.stdout = new EventEmitter(); c.stdout.setEncoding = () => {}; c.stderr = { resume() {} };
    c.stdin = { on() {}, end() {} };
    setImmediate(() => { c.stdout.emit('data', `${line}\n`); c.stdout.emit('end'); c.emit('close', 0); });
    return c;
  };
  for (let i = 0; i < 2; i++) await liveReading({ claude: 'claude', spawn, env: { ...process.env }, home, dataDir, timeoutMs: 5000 }).catch(() => {});
  assert.equal(cwds.length, 2);
  assert.equal(cwds[0], cwds[1]);
  assert.equal(cwds[0], path.join(dataDir, 'accounts', 'live-reading'));
  assert.ok(fs.statSync(cwds[0]).isDirectory());
});
