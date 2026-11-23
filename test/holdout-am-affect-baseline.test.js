// Baseline (#2288): what activity rows and the run detail do today; must pass before and after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

function setup() {
  const store = openStore(tmp('am-affect-b-'));
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), port: 4747, defer: (fn) => fn(), clock: () => Date.now() });
  const { run } = store.startRun({ title: 'R' });
  store.linkSession('cs', run.id);
  return { store, id: run.id, ev: (n, extra = {}) => hooks.handle({ session_id: 'cs', cwd: '/x', hook_event_name: n, ...extra }) };
}

test('tool and error activity rows keep their old keys, order and summaries', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' }, tool_use_id: 'b1' });
  t.ev('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'b1', error: 'nope' });
  t.ev('PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/a/b.js' }, tool_use_id: 'b2' });
  t.ev('PostToolUse', { tool_name: 'Read', tool_use_id: 'b2' });
  const a = t.store.detail(t.id).activity;
  assert.deepEqual(a.map((r) => r.event), ['tool', 'error', 'tool']);
  assert.equal(a[2].tool, 'Bash');
  assert.equal(a[2].summary, 'git status');
  assert.equal(a[1].summary, 'nope');
  for (const k of ['at', 'agentId', 'event', 'tool', 'summary']) assert.ok(k in a[0], k);
  const ag = t.store.detail(t.id).agents.find((x) => x.id === 'main:cs');
  assert.equal(ag.toolCalls, 2);
  assert.equal(ag.errors, 1);
  assert.equal(ag.lastTool, 'Read');
  t.store.close();
});

test('PostToolUse without a PreToolUse and with no id stores nothing; hooks answer {}', () => {
  const t = setup();
  assert.deepEqual(t.ev('PostToolUse', { tool_name: 'Bash' }), {});
  assert.equal(t.store.detail(t.id).activity.length, 0);
  t.store.close();
});

test('Stop and SubagentStop still leave their activity rows', () => {
  const t = setup();
  t.ev('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: 'b9' });
  t.ev('Stop', {});
  const ev = t.store.detail(t.id).activity.map((r) => r.event);
  assert.ok(ev.includes('tool') && ev.includes('stop'), ev.join(','));
  t.store.close();
});
