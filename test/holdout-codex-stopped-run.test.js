// Holdouts for AC9: a stopped run denies new subagents only until the main session's next UserPromptSubmit.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { bootCodex, denied, reason } from './holdout-codex-helpers.js';

let a;
before(async () => { a = await bootCodex({ codex: false }); });
after(async () => { await a.close(); });

const ev = (session, hook_event_name, extra = {}) => a.post({ hook_event_name, session_id: session, cwd: a.root, ...extra });
const pre = (session, extra = {}) => ev(session, 'PreToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_use_id: `t${Math.random()}`, ...extra });
const agentIds = async (id) => (await a.detail(id)).agents.map((x) => x.id);

test('before the next prompt a new unknown subagent of a stopped run is denied (unchanged behaviour)', async () => {
  const id = await a.startRun('S1');
  await a.link('s1', id);
  await a.api('POST', `/api/runs/${id}/stop`);
  const r = await pre('s1', { agent_id: 'new1' });
  assert.ok(denied(r));
  assert.match(reason(r), /stopped/);
});

test('after UserPromptSubmit, new subagents are not adopted by the stopped run; known ones stay denied', async () => {
  const id = await a.startRun('S2');
  await a.link('s2', id);
  await a.post({ hook_event_name: 'SubagentStart', session_id: 's2', cwd: a.root, agent_id: 'old2', agent_type: 'worker' });
  await a.api('POST', `/api/runs/${id}/stop`);
  assert.ok(denied(await pre('s2', { agent_id: 'old2' })));
  assert.ok(denied(await pre('s2', { agent_id: 'fresh-before' })), 'new subagent before the prompt is denied');
  await ev('s2', 'UserPromptSubmit', { prompt: 'new task please' });
  const fresh = await pre('s2', { agent_id: 'fresh-after' });
  assert.ok(!denied(fresh), 'a new subagent is not denied after the prompt');
  assert.deepEqual(fresh.json, {});
  assert.ok(!(await agentIds(id)).includes('fresh-after'), 'and does not join the stopped run');
  assert.ok(denied(await pre('s2', { agent_id: 'old2' })), 'a subagent that already belonged stays denied');
  assert.ok(denied(await pre('s2', { agent_id: 'fresh-before' })), 'so does the one adopted before the prompt');
});

test('the main session is dropped after the prompt and a new run links normally', async () => {
  const id = await a.startRun('S3');
  await a.link('s3', id);
  await a.api('POST', `/api/runs/${id}/stop`);
  await ev('s3', 'UserPromptSubmit', { prompt: 'go' });
  assert.deepEqual((await pre('s3')).json, {}, 'main session no longer tracked by the stopped run');
  const id2 = await a.startRun('S3 second');
  await a.link('s3', id2);
  await a.post({ hook_event_name: 'SubagentStart', session_id: 's3', cwd: a.root, agent_id: 'sub-new-run', agent_type: 'worker' });
  assert.ok((await agentIds(id2)).includes('sub-new-run'), 'a subagent joins the new run');
  assert.ok(!(await agentIds(id)).includes('sub-new-run'));
});

test('a subagent UserPromptSubmit does not release the session; a live run stays linked after a main prompt', async () => {
  const id = await a.startRun('S4');
  await a.link('s4', id);
  await a.api('POST', `/api/runs/${id}/stop`);
  await ev('s4', 'UserPromptSubmit', { agent_id: 'subprompt', prompt: 'x' });
  assert.ok(denied(await pre('s4', { agent_id: 'still-new' })), 'still denied: only the main session frees it');
  const live = await a.startRun('S4 live');
  await a.link('s5', live);
  await ev('s5', 'UserPromptSubmit', { prompt: 'continue' });
  await a.post({ hook_event_name: 'SubagentStart', session_id: 's5', cwd: a.root, agent_id: 'live-sub', agent_type: 'worker' });
  assert.ok((await agentIds(live)).includes('live-sub'), 'live run keeps adopting subagents');
});
