// EXPLOIT (fixed): validation only checked stage ORDER for a pushes stage, not the paths that reach it.
// A workflow that passes validation can reach the pushes node ('pr') without Gate 2.
// Graph form: an edge into 'pr' from a fix step or from a gate before the checks.
// Secure behaviour asserted: publish refuses these workflows (400) with an error on 'pr'.
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
const refusedOnPr = (r) => r.status === 400 && r.json.errors.some((e) => e.node === 'pr' && /pushes/.test(e.message));
const edgeOf = (wf, from, on) => wf.edges.find((e) => e.from === from && e.on === on);

test('edge fix -> pr: a finished fix goes straight to the push, no gate', async () => {
  const wf = await seed();
  edgeOf(wf, 'fix', 'done').to = 'pr';
  const r = await publish(wf);
  assert.ok(refusedOnPr(r), `workflow with fix -> pr was not refused on pr: ${r.status} ${r.text}`);
});

test('gate1 "Agree spec" -> pr skips the checks and Gate 2', async () => {
  const wf = await seed();
  edgeOf(wf, 'gate1', 'Agree spec').to = 'pr';
  const r = await publish(wf);
  assert.ok(refusedOnPr(r), 'workflow where gate1 "Agree spec" jumps to pr was not refused on pr');
});

test('an extra gate1 action straight to pr (nothing else wrong with the graph)', async () => {
  const wf = await seed();
  wf.nodes.find((n) => n.id === 'gate1').actions.push({ label: 'Ship now' });
  wf.edges.push({ id: 'gate1>pr:Ship now', from: 'gate1', to: 'pr', on: 'Ship now' });
  const r = await publish(wf);
  assert.equal(r.status, 400, 'workflow with a gate1 shortcut to pr was PUBLISHED');
  assert.deepEqual(r.json.errors.map((e) => e.node), ['pr'], 'the push rule is the only thing that refuses it');
});

test('end-to-end: run reaches pr via fix without gate2', async () => {
  const wf = await seed();
  edgeOf(wf, 'fix', 'done').to = 'pr';
  const r = await publish(wf);
  if (r.status !== 200) return; // secure: refused
  const run = runIdOf((await M.call('start_run', { title: 'bypass' })).text);
  await M.call('complete_stage', { run, stage: 'frame', outcome: 'pass' });
  await S.api('POST', `/api/runs/${run}/respond`, { body: { action: 'Agree spec', text: 'x' } });
  for (const st of ['plan', 'implement', 'prep']) await M.call('complete_stage', { run, stage: st, outcome: 'pass' });
  await M.call('complete_stage', { run, stage: 'verify', outcome: 'fail', note: 'x' });
  await M.call('complete_stage', { run, stage: 'fix', outcome: 'pass' });
  const now = (await S.api('GET', `/api/runs/${run}`)).json.run;
  assert.notEqual(now.stage, 'pr', 'run is at the pushes node without passing gate2');
});
