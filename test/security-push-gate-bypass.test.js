// EXPLOIT (fixed): validation only checked stage ORDER for a pushes stage, not the paths that reach it.
// A workflow that passes validation can reach the pushes stage ('pr') without Gate 2.
// Secure behaviour asserted: publish refuses these workflows (400).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient, runIdOf } from './holdout-helpers.js';
let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const seed = async () => (await S.api('GET', '/api/workflow')).json.published.workflow;
const publish = async (wf) => {
  await S.api('PUT', '/api/workflow/draft', { body: { workflow: wf } });
  return S.api('POST', '/api/workflow/publish');
};

test('loop.afterFix = pushes stage: a finished fix goes straight to the push, no gate', async () => {
  const wf = await seed();
  wf.loop.afterFix = 'pr';
  const r = await publish(wf);
  assert.equal(r.status, 400, 'workflow with afterFix -> pr was PUBLISHED');
});

test('early gate action goto pushes stage skips checks and Gate 2', async () => {
  const wf = await seed();
  wf.stages.find((s) => s.id === 'gate1').actions[0].goto = 'pr';
  const r = await publish(wf);
  assert.equal(r.status, 400, 'workflow where gate1 "Agree spec" jumps to pr was PUBLISHED');
});

test('end-to-end: run reaches pr via fix without gate2', async () => {
  const wf = await seed();
  wf.loop.afterFix = 'pr';
  const r = await publish(wf);
  if (r.status !== 200) return; // secure: refused
  const run = runIdOf((await M.call('start_run', { title: 'bypass' })).text);
  await M.call('complete_stage', { run, stage: 'frame', outcome: 'pass' });
  await S.api('POST', `/api/runs/${run}/respond`, { body: { action: 'Agree spec', text: 'x' } });
  for (const st of ['plan', 'implement']) await M.call('complete_stage', { run, stage: st, outcome: 'pass' });
  await M.call('complete_stage', { run, stage: 'verify', outcome: 'fail', note: 'x' });
  await M.call('complete_stage', { run, stage: 'fix', outcome: 'pass' });
  const now = (await S.api('GET', `/api/runs/${run}`)).json.run;
  assert.notEqual(now.stage, 'pr', 'run is at the pushes stage without passing gate2');
});
