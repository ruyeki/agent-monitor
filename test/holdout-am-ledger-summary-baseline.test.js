// Baseline: what the Ledger summary and parsers do today (base commit).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyChanges } from '../src/ledger.js';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

let n = 0;
const row = (input, result = null, outcome = 'ok') => { n++; return { id: n, at: 1000 + n, agentId: 'a', tool: 'Bash', toolUseId: `b${n}`, input, result, outcome }; };
const COMMIT = '[feat/x 274eae5] Answer things\n 4 files changed, 169 insertions(+), 120 deletions(-)\n';
const PUSH = 'To github.com:o/r.git\n   4ec2e9f..3a44b3a  main -> main\n';

test('base: existing summary fields and total', () => {
  const { items, summary } = classifyChanges([row('git commit -m x', COMMIT), row('git push origin main', PUSH), row('pm2 restart agent-monitor'), row('gh pr merge 9')]);
  assert.equal(items.length, 4);
  assert.equal(summary.total, 4);
  assert.deepEqual([summary.commits, summary.files, summary.insertions, summary.deletions, summary.pushes, summary.restarts], [1, 4, 169, 120, 1, 1]);
});

test('base: commit with stats parsed from its own output; -q commit shows generic title and null stats', () => {
  const [c] = classifyChanges([row('git commit -m "Answer things"', COMMIT)]).items;
  assert.match(c.title, /274eae5/);
  assert.deepEqual(c.stats, { files: 4, insertions: 169, deletions: 120 });
  const [q] = classifyChanges([row('git commit -q -m "quiet one"', '')]).items;
  assert.equal(q.stats, null);
});

test('base: a single push and a single PR parse', () => {
  const [p] = classifyChanges([row('git push origin main', PUSH)]).items;
  assert.match(p.title, /Pushed main to GitHub/);
  const [r] = classifyChanges([row('gh pr create --title T', 'https://github.com/o/r/pull/12\n')]).items;
  assert.match(r.title, /#12/);
});

test('base: hook stores a small result as it came and ends the row', () => {
  const store = openStore(tmp('am-bl-'));
  const hooks = createHooks(store, { projectsDir: tmp('am-p-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('s', run.id);
  const ev = (hook_event_name, x) => hooks.handle({ session_id: 's', cwd: '/x', hook_event_name, ...x });
  ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git push origin main' }, tool_use_id: 'u1' });
  ev('PostToolUse', { tool_name: 'Bash', tool_use_id: 'u1', tool_response: { stdout: PUSH, stderr: '' } });
  const [c] = store.changesOf(run.id);
  assert.equal(c.outcome, 'ok');
  assert.match(c.result, /3a44b3a/);
});
