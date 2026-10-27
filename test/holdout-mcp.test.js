import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { boot, mcpClient, runIdOf, REPO } from './holdout-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch {} await S?.srv.close(); });

const lines = (t) => t.split('\n');

test('AC7 tool list', async () => {
  const { tools } = await M.client.listTools();
  const names = tools.map((t) => t.name).sort();
  for (const n of ['complete_stage', 'get_run', 'get_workflow', 'list_runs', 'log', 'respond', 'start_run']) assert.ok(names.includes(n), n);
  assert.ok(tools.every((t) => t.description && t.description.length < 600), 'short descriptions');
});

test('AC7 start_run: first line is RUN <id> with stage, round and status; NEXT and INSTRUCTIONS follow', async () => {
  const r = await M.call('start_run', { title: 'My First Run', task: 'a task', repo: 'repo', branch: 'br' });
  assert.equal(r.isError, false);
  const l = lines(r.text);
  assert.match(l[0], /^RUN my-first-run · stage frame \(.+\) · round 0\/5 · status active$/);
  assert.match(l[1], /^NEXT: frame \(.+\) — runner main, model inherit$/);
  assert.match(l[2], /^INSTRUCTIONS: .{5,}/);
});

test('AC7 run ids: slug arg, slugified title, collisions get -2 -3', async () => {
  const a = runIdOf((await M.call('start_run', { title: 'Same Title!' })).text);
  const b = runIdOf((await M.call('start_run', { title: 'Same Title!' })).text);
  const c = runIdOf((await M.call('start_run', { title: 'Same Title!' })).text);
  assert.equal(a, 'same-title');
  assert.equal(b, 'same-title-2');
  assert.equal(c, 'same-title-3');
  assert.equal(runIdOf((await M.call('start_run', { title: 'Whatever', slug: 'my-slug' })).text), 'my-slug');
  assert.equal(runIdOf((await M.call('start_run', { title: 'Whatever', slug: 'my-slug' })).text), 'my-slug-2');
  const weird = runIdOf((await M.call('start_run', { title: '  ÄÖ -- Fix #12: the/thing?  ' })).text);
  assert.match(weird, /^[a-z0-9][a-z0-9-]*$/);
  const sym = await M.call('start_run', { title: '!!!' });
  if (!sym.isError) assert.match(runIdOf(sym.text), /^[a-z0-9][a-z0-9-]*$/);
});

test('AC7 complete_stage into a gate: WAITING ON RYAN, ACTIONS with text allowed, background wait hint', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Gate flow' })).text);
  const r = await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass', note: 'framed' });
  assert.equal(r.isError, false);
  const l = lines(r.text);
  assert.match(l[0], new RegExp(`^RUN ${id} · stage gate1 \\(.+\\) · round 0/5 · status waiting$`));
  assert.ok(l.includes("WAITING ON RYAN: What's your solution?"), r.text);
  assert.ok(l.includes('ACTIONS: Agree spec | Stop run (text allowed)'), r.text);
  const bg = l.find((x) => x.startsWith('Run in the background:'));
  assert.ok(bg, r.text);
  assert.ok(bg.includes('bin') && bg.includes('agent-monitor.js') && bg.includes(`wait ${id}`), bg);
  assert.ok(!l.some((x) => x.startsWith('NEXT:')), 'no NEXT while waiting');
});

test('AC7 complete_stage while waiting is an error that says respond', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Waiting reject' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  const r = await M.call('complete_stage', { run: id, stage: 'gate1', outcome: 'pass' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^ERROR: /);
  assert.match(r.text, /respond/);
});

test('AC7 wrong stage and bad outcome and unknown run are isError with ERROR:', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Wrong stage' })).text);
  let r = await M.call('complete_stage', { run: id, stage: 'verify', outcome: 'pass' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^ERROR: /);
  assert.match(r.text, /'verify'/);
  assert.match(r.text, /Active: frame/);
  r = await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'bogus' });
  assert.equal(r.isError, true);
  r = await M.call('complete_stage', { run: 'no-such-run', stage: 'frame', outcome: 'pass' });
  assert.equal(r.isError, true);
  assert.match(r.text, /^ERROR: /);
  r = await M.call('get_run', { run: 'no-such-run' });
  assert.equal(r.isError, true);
  r = await M.call('respond', { run: 'no-such-run', action: 'x' });
  assert.equal(r.isError, true);
  r = await M.call('log', { run: 'no-such-run', note: 'x' });
  assert.equal(r.isError, true);
});

test('AC7 respond: result shows next stage; bad action is an error listing labels', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Respond flow' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  let r = await M.call('respond', { run: id, action: 'Dance' });
  assert.equal(r.isError, true);
  assert.match(r.text, /Agree spec/);
  r = await M.call('respond', { run: id, action: 'Agree spec', text: 'my solution' });
  assert.equal(r.isError, false);
  assert.match(lines(r.text)[0], new RegExp(`^RUN ${id} · stage plan .* status active$`));
  assert.match(r.text, /NEXT: plan \(.+\) — runner lead, model opus/);
  r = await M.call('respond', { run: id, action: 'Agree spec' });
  assert.equal(r.isError, true, 'run is no longer waiting');
});

test('AC7 fail loop through MCP: fix rounds then decision then Resume, with round shown', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Loop flow' })).text);
  const go = async (stage, outcome, note) => M.call('complete_stage', { run: id, stage, outcome, note });
  await go('frame', 'pass'); await M.call('respond', { run: id, action: 'Agree spec', text: 's' });
  await go('plan', 'pass'); await go('implement', 'pass'); await go('prep', 'pass');
  let r = await go('verify', 'fail', 'tests red');
  assert.match(lines(r.text)[0], /stage fix .* round 1\/5 · status active/);
  assert.match(r.text, /runner worker, model sonnet/);
  r = await go('fix', 'pass');
  assert.match(lines(r.text)[0], /stage verify .* round 1\/5/);
  for (let i = 2; i <= 5; i++) { await go('verify', 'fail', 'again'); r = await go('fix', 'done'); }
  r = await go('verify', 'fail', 'again');
  assert.match(lines(r.text)[0], /stage decision .* round 5\/5 · status waiting/);
  assert.ok(r.text.includes('WAITING ON RYAN: again (fix round limit 5 reached)'), r.text);
  assert.ok(r.text.includes('ACTIONS: Resume | Stop run (text allowed)'), r.text);
  r = await M.call('respond', { run: id, action: 'Resume', text: 'replan' });
  assert.match(lines(r.text)[0], /stage plan .* round 0\/5 · status active/);
});

test('AC7 regression goes to decision with the note as the ask', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Regress flow' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  await M.call('respond', { run: id, action: 'Agree spec' });
  await M.call('complete_stage', { run: id, stage: 'plan', outcome: 'pass' });
  await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'pass' });
  await M.call('complete_stage', { run: id, stage: 'prep', outcome: 'pass' });
  const r = await M.call('complete_stage', { run: id, stage: 'verify', outcome: 'regression', note: 'broke login' });
  assert.ok(r.text.includes('WAITING ON RYAN: broke login'), r.text);
});

test('AC7 full walk to done: only the RUN line with status done', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Full walk' })).text);
  const c = (stage, outcome = 'pass') => M.call('complete_stage', { run: id, stage, outcome });
  await c('frame'); await M.call('respond', { run: id, action: 'Agree spec' });
  for (const s of ['plan', 'implement', 'prep', 'verify', 'review', 'whitehat', 'commit', 'report']) await c(s);
  let r = await M.call('respond', { run: id, action: 'Accept', text: '' });
  assert.match(lines(r.text)[0], /stage pr .* status active/);
  r = await c('pr');
  assert.equal(r.isError, false);
  assert.equal(lines(r.text).filter(Boolean).length, 1, r.text);
  assert.match(r.text, new RegExp(`^RUN ${id} · .*status done`));
  assert.equal((await M.call('complete_stage', { run: id, stage: 'pr', outcome: 'pass' })).isError, true);
});

test('AC7 Stop run through MCP ends the run', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Stop via mcp' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  const r = await M.call('respond', { run: id, action: 'Stop run', text: 'no' });
  assert.match(r.text, /status stopped/);
  const g = await M.call('get_run', { run: id });
  assert.match(lines(g.text)[0], /status stopped/);
});

test('AC7 log and get_run; log shows in the timeline', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Log flow' })).text);
  const l = await M.call('log', { run: id, note: 'halfway there' });
  assert.equal(l.isError, false);
  assert.match(lines(l.text)[0], new RegExp(`^RUN ${id}`));
  const g = await M.call('get_run', { run: id });
  assert.match(lines(g.text)[0], new RegExp(`^RUN ${id} · stage frame`));
  const detail = (await S.api('GET', `/api/runs/${id}`)).json;
  assert.ok(detail.timeline.some((t) => t.kind === 'log' && t.note === 'halfway there'));
});

test('AC7 list_runs puts active/waiting runs first with short lines', async () => {
  const stopped = runIdOf((await M.call('start_run', { title: 'List stopped' })).text);
  await M.call('complete_stage', { run: stopped, stage: 'frame', outcome: 'pass' });
  await M.call('respond', { run: stopped, action: 'Stop run' });
  const live = runIdOf((await M.call('start_run', { title: 'List live' })).text);
  const r = await M.call('list_runs', {});
  assert.equal(r.isError, false);
  const ls = lines(r.text).filter(Boolean);
  const iLive = ls.findIndex((x) => x.includes(live));
  const iStopped = ls.findIndex((x) => x.includes(stopped));
  assert.ok(iLive >= 0 && iStopped >= 0);
  assert.ok(iLive < iStopped, 'active before stopped');
  assert.ok(ls.every((x) => x.length < 300));
});

test('AC7 get_workflow without run returns the published workflow text naming stages', async () => {
  const r = await M.call('get_workflow', {});
  assert.equal(r.isError, false);
  for (const id of ['frame', 'gate1', 'plan', 'split', 'implement', 'prep', 'join', 'verify', 'fix', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr', 'decision', 'done', 'stopped']) assert.ok(r.text.includes(id), id);
  for (const l of ['verify -fail-> fix (fix round)', 'gate2 -Accept-> pr', 'split -*-> prep']) assert.ok(lines(r.text).includes(l), l);
  assert.ok(lines(r.text).indexOf('Edges:') > lines(r.text).findIndex((l) => l.startsWith('18. ')), 'nodes, then edges');
});

test('AC6 two active nodes: both listed with runner, model and instructions, and a PARALLEL line', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Parallel flow' })).text);
  await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  await M.call('respond', { run: id, action: 'Agree spec' });
  const r = await M.call('complete_stage', { run: id, stage: 'plan', outcome: 'done' });
  const l = lines(r.text);
  assert.equal(l[0], `RUN ${id} · stage implement (Implement) + prep (Verifier prep) · round 0/5 · status active`);
  assert.ok(l.includes('PARALLEL: run these together, then report each with complete_stage.'), r.text);
  assert.deepEqual(l.filter((x) => x.startsWith('NEXT:')), ['NEXT: implement (Implement) — runner worker, model sonnet', 'NEXT: prep (Verifier prep) — runner verifier, model sonnet']);
  assert.equal(l.filter((x) => x.startsWith('INSTRUCTIONS: ')).length, 2);
  assert.match((await M.call('get_run', { run: id })).text, /PARALLEL:/);
  const half = await M.call('complete_stage', { run: id, stage: 'prep', outcome: 'pass' });
  assert.ok(!half.text.includes('PARALLEL'), half.text);
  assert.match(lines(half.text)[0], /stage implement \(Implement\) · round/);
  const err = await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'regression' });
  assert.equal(err.isError, true);
  assert.match(err.text, /Valid outcomes: pass, done/);
  const joined = await M.call('complete_stage', { run: id, stage: 'implement', outcome: 'pass' });
  assert.match(lines(joined.text)[0], /stage verify \(Verify\)/);
});

test('AC7 stateless: a second independent client works and sees the same runs', async () => {
  const m2 = await mcpClient(S.url);
  try {
    const r = await m2.call('list_runs', {});
    assert.equal(r.isError, false);
    assert.ok(r.text.length > 0);
  } finally { await m2.client.close(); }
});

test('AC7 the repo path in the wait hint points at this repo', async () => {
  const id = runIdOf((await M.call('start_run', { title: 'Hint path' })).text);
  const r = await M.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  const hint = r.text.split('\n').find((x) => x.startsWith('Run in the background:'));
  const norm = hint.replace(/\\/g, '/').toLowerCase();
  assert.ok(norm.includes(REPO.toLowerCase().replace(/\\/g, '/') + '/bin/agent-monitor.js'), hint);
});
