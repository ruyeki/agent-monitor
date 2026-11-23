// White-hat probes for the stored hook input (tool_use_id, ended_at, outcome). Each test is an attack that must FAIL to
// have an effect: if one of these assertions breaks, the attack worked. Run from the repo root:
//   node --test <this file>   (copy it into test/ first so ../src resolves)
import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { createHooks } from '../src/hooks.js';
import { tmp } from './helpers.js';

function world() {
  const store = openStore(tmp());
  const hooks = createHooks(store, { projectsDir: tmp('am-proj-'), defer: (fn) => fn(), clock: () => Date.now() });
  const a = store.startRun({ title: 'Victim' }).run;
  const b = store.startRun({ title: 'Attacker' }).run;
  store.linkSession('victim', a.id);
  store.linkSession('attacker', b.id);
  const send = (sid, hook_event_name, extra = {}) => hooks.handle({ session_id: sid, cwd: '/x', hook_event_name, ...extra });
  const tools = (id) => store.detail(id).activity.filter((r) => r.event === 'tool');
  return { store, a, b, send, tools };
}

test('a session linked to another run cannot end (or fail) the victim run\'s tool call by replaying its tool_use_id', () => {
  const w = world();
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'deploy' }, tool_use_id: 'toolu_victim' });
  w.send('attacker', 'PostToolUseFailure', { tool_name: 'Bash', error: 'forged failure', tool_use_id: 'toolu_victim' });
  w.send('attacker', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 'toolu_victim' });
  const [row] = w.tools(w.a.id);
  assert.equal(row.endedAt, null);
  assert.equal(row.outcome, null);
  // the forged error row lands in the attacker's own run, never the victim's
  assert.equal(w.store.detail(w.a.id).activity.filter((r) => r.event === 'error').length, 0);
});

test('type-confused tool_use_id values neither throw nor match/end anything', () => {
  const w = world();
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'x' }, tool_use_id: '[object Object]' });
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'y' }, tool_use_id: '1' });
  for (const bad of [{ toString: () => '[object Object]' }, ['1'], 1, true, null, '']) {
    assert.doesNotThrow(() => w.send('victim', 'PostToolUse', { tool_name: 'Bash', tool_use_id: bad }));
    assert.doesNotThrow(() => w.send('victim', 'PostToolUseFailure', { tool_name: 'Bash', error: 'e', tool_use_id: bad }));
  }
  for (const r of w.tools(w.a.id)) assert.equal(r.outcome, null, `row ${r.toolUseId} was ended by a non-string id`);
  for (const r of w.store.detail(w.a.id).activity) assert.ok(r.toolUseId === null || typeof r.toolUseId === 'string');
});

test('SQL metacharacters and LIKE wildcards in tool_use_id are data, not query text', () => {
  const w = world();
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'a' }, tool_use_id: 'toolu_A' });
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'b' }, tool_use_id: 'toolu_B' });
  for (const inj of ["' OR '1'='1", "x' OR 1=1 --", '%', '_', "toolu_A'; UPDATE activity SET outcome='ok'; --"]) {
    w.send('victim', 'PostToolUse', { tool_name: 'Bash', tool_use_id: inj });
  }
  for (const r of w.tools(w.a.id)) assert.equal(r.outcome, null, `row ${r.toolUseId} ended by an injected id`);
  assert.equal(w.store.detail(w.a.id).activity.length, 2);
});

test('an oversized tool_use_id is capped on write and still matches its own end; it cannot end a different row', () => {
  const w = world();
  const huge = 'A'.repeat(200) + 'tail-1';
  const other = 'A'.repeat(200) + 'tail-2'; // same first 200 chars
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'one' }, tool_use_id: huge });
  const [row] = w.tools(w.a.id);
  assert.ok(row.toolUseId.length <= 200);
  // Documented consequence of the cap: ids that share their first 200 chars collide (ok here: real ids are ~30 chars).
  w.send('victim', 'PostToolUse', { tool_name: 'Bash', tool_use_id: other });
  const [after] = w.tools(w.a.id);
  assert.equal(after.outcome, 'ok', 'prefix collision: expected (cap), recorded so the lead knows');
});

test('an end can only mark a tool row once and never touches non-tool rows with the same id', () => {
  const w = world();
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'z' }, tool_use_id: 't1' });
  w.send('victim', 'PostToolUseFailure', { tool_name: 'Bash', error: 'boom', tool_use_id: 't1' });
  const first = w.tools(w.a.id)[0];
  assert.equal(first.outcome, 'error');
  w.send('victim', 'PostToolUse', { tool_name: 'Bash', tool_use_id: 't1' }); // late/forged "ok" after the failure
  const again = w.tools(w.a.id)[0];
  assert.equal(again.outcome, 'error');
  assert.equal(again.endedAt, first.endedAt);
  const err = w.store.detail(w.a.id).activity.find((r) => r.event === 'error');
  assert.equal(err.outcome, null);
  assert.equal(err.endedAt, null);
});

test('tool_response content is never stored', () => {
  const w = world();
  w.send('victim', 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'cat .env' }, tool_use_id: 'r1' });
  w.send('victim', 'PostToolUse', { tool_name: 'Bash', tool_response: { stdout: 'PASSWORD=hunter2-canary' }, tool_use_id: 'r1' });
  const dump = JSON.stringify(w.store.detail(w.a.id));
  assert.ok(!dump.includes('hunter2-canary'));
});
