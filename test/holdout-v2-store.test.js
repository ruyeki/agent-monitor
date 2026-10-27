// Holdout: AC4/AC6/AC8 at the store level (parallel runs, visits, summaries, drafts, publish). Fresh temp DBs only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { load, tmp } from './holdout-v2-helpers.js';

const open = async (dir = tmp()) => { const { openStore } = await load('src/store.js'); return openStore(dir); };
const sqlite = async () => { const m = await import('node:sqlite'); return m.DatabaseSync; };
const ids = (arr) => arr.map((x) => x.id).sort();

function toSplit(s, title = 'P') {
  const { run } = s.startRun({ title });
  const id = run.id;
  assert.ok(!s.completeStage(id, { stage: 'frame', outcome: 'done' }).error);
  assert.ok(!s.respond(id, { action: 'Agree spec', text: 'spec' }).error);
  assert.ok(!s.completeStage(id, { stage: 'plan', outcome: 'done' }).error);
  return id;
}
const toVerify = (s, title) => {
  const id = toSplit(s, title);
  for (const st of ['implement', 'prep']) assert.ok(!s.completeStage(id, { stage: st, outcome: 'done' }).error);
  return id;
};
const step = (s, id, stage, outcome, note) => { const r = s.completeStage(id, { stage, outcome, note }); assert.ok(!r.error, r.error); return r.run; };

test('fresh store: published v1 is the seed graph and the draft equals it', async () => {
  const { seedWorkflow } = await load('src/workflow.js');
  const s = await open();
  assert.equal(s.published().version, 1);
  assert.deepEqual(s.published().workflow, seedWorkflow());
  assert.deepEqual(s.draft().workflow, seedWorkflow());
  assert.deepEqual(s.draft().errors, []);
  assert.equal(s.draft().baseVersion, 1);
});

test('fresh store: user_version 2, new columns and the node_visits table exist', async () => {
  const dir = tmp();
  const s = await open(dir);
  s.close();
  const DB = await sqlite();
  const db = new DB(path.join(dir, 'agent-monitor.db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
  assert.ok(cols('runs').includes('active_json') && cols('runs').includes('joins_json'));
  assert.ok(cols('agents').includes('start_nodes') && cols('agents').includes('reported_nodes'));
  assert.deepEqual(cols('node_visits').sort(), ['entered_at', 'id', 'left_at', 'node_id', 'outcome', 'run_id'].sort());
  db.close();
});

test('start: summary lists the active node and keeps the v1 fields', async () => {
  const s = await open();
  const { run } = s.startRun({ title: 'One', repo: 'r', branch: 'b', note: 'hello' });
  assert.equal(run.stage, 'frame');
  assert.equal(run.status, 'active');
  assert.equal(run.maxRounds, 5);
  assert.equal(run.workflowVersion, 1);
  assert.deepEqual(run.active.map((a) => ({ id: a.id, type: a.type })), [{ id: 'frame', type: 'step' }]);
  assert.equal(typeof run.active[0].name, 'string');
  assert.equal(run.stageName, run.active[0].name);
  assert.deepEqual(run.actions, []);
  assert.equal(run.textField, false);
});

test('a waiting gate shows its ask, actions and textField through the summary', async () => {
  const s = await open();
  const { run } = s.startRun({ title: 'Gate' });
  const r = step(s, run.id, 'frame', 'done');
  assert.equal(r.status, 'waiting');
  assert.equal(r.stage, 'gate1');
  assert.deepEqual(r.active.map((a) => a.id), ['gate1']);
  assert.equal(r.ask, "What's your solution?");
  assert.deepEqual(r.actions, [{ label: 'Agree spec' }, { label: 'Stop run' }]);
  assert.equal(r.textField, true);
});

test('parallel: both nodes are active, stage is the first of them, and the row columns agree', async () => {
  const s = await open();
  const id = toSplit(s);
  const sum = s.summary(s.getRun(id));
  assert.deepEqual(ids(sum.active), ['implement', 'prep']);
  assert.equal(sum.status, 'active');
  assert.ok(['implement', 'prep'].includes(sum.stage));
  assert.equal(sum.stage, sum.active[0].id);
  const row = s.getRun(id);
  assert.equal(row.stage, sum.stage);
  assert.deepEqual(JSON.parse(row.active_json).sort(), ['implement', 'prep']);
  assert.match(s.completeStage(id, { stage: 'verify', outcome: 'pass' }).error, /^Stage 'verify' is not active\. Active: /);
});

test('join: the run moves on only after the last branch, and the join state is cleared', async () => {
  const s = await open();
  const id = toSplit(s);
  step(s, id, 'prep', 'done');
  assert.deepEqual(s.summary(s.getRun(id)).active.map((a) => a.id), ['implement']);
  assert.notEqual(JSON.parse(s.getRun(id).joins_json), null);
  assert.equal(s.getRun(id).stage, 'implement');
  const r = step(s, id, 'implement', 'done');
  assert.deepEqual(r.active.map((a) => a.id), ['verify']);
  assert.equal(r.stage, 'verify');
  assert.deepEqual(JSON.parse(s.getRun(id).active_json), ['verify']);
  assert.deepEqual(JSON.parse(s.getRun(id).joins_json ?? '{}'), {});
});

test('parallel state survives a restart', async () => {
  const dir = tmp();
  let s = await open(dir);
  const id = toSplit(s);
  step(s, id, 'implement', 'done');
  s.close();
  s = await open(dir);
  assert.deepEqual(s.summary(s.getRun(id)).active.map((a) => a.id), ['prep']);
  const r = step(s, id, 'prep', 'done');
  assert.equal(r.stage, 'verify');
});

test('fix loop at the store: round counts, limit goes to decision, Resume resets and re-plans', async () => {
  const s = await open();
  const id = toVerify(s);
  for (let i = 1; i <= 5; i++) {
    const r = step(s, id, 'verify', 'fail', `red ${i}`);
    assert.equal(r.stage, 'fix');
    assert.equal(r.round, i);
    step(s, id, 'fix', 'done');
  }
  const d = step(s, id, 'verify', 'fail', 'again');
  assert.equal(d.stage, 'decision');
  assert.equal(d.status, 'waiting');
  assert.equal(d.ask, 'again (fix round limit 5 reached)');
  assert.deepEqual(d.actions, [{ label: 'Resume' }, { label: 'Stop run' }]);
  const r = s.respond(id, { action: 'Resume', text: '' }).run;
  assert.equal(r.round, 0);
  assert.equal(r.stage, 'plan');
});

test('visits: detail lists them in order, closed ones carry the outcome, the open one has no end', async () => {
  const s = await open();
  const id = toVerify(s);
  const d = s.detail(id);
  const v = d.visits;
  assert.ok(Array.isArray(v));
  const at = (n) => v.findIndex((x) => x.node === n);
  assert.ok(at('frame') < at('gate1') && at('gate1') < at('plan') && at('plan') < Math.min(at('implement'), at('prep')) && Math.max(at('implement'), at('prep')) < at('verify'), 'visits are in entry order');
  for (const n of ['frame', 'gate1', 'plan', 'implement', 'prep', 'verify']) assert.ok(v.some((x) => x.node === n), `visit of ${n}`);
  assert.ok(!v.some((x) => x.node === 'split' || x.node === 'join'), 'split and join are transient, not visits');
  const frame = v.find((x) => x.node === 'frame');
  assert.equal(frame.outcome, 'done');
  assert.ok(frame.enteredAt && frame.leftAt);
  assert.ok(Date.parse(frame.leftAt) >= Date.parse(frame.enteredAt));
  const opened = v.filter((x) => x.leftAt === null);
  assert.deepEqual(opened.map((x) => x.node), ['verify']);
  assert.equal(opened[0].outcome, null);
  const impl = v.find((x) => x.node === 'implement');
  assert.equal(impl.outcome, 'done');
});

test('visits: nodes summary counts repeat visits and the run has a duration', async () => {
  const s = await open();
  const id = toVerify(s);
  step(s, id, 'verify', 'fail', 'r1'); step(s, id, 'fix', 'done');
  step(s, id, 'verify', 'fail', 'r2'); step(s, id, 'fix', 'done');
  const d = s.detail(id);
  assert.equal(d.nodes.verify.visits, 3);
  assert.equal(d.nodes.fix.visits, 2);
  assert.equal(d.nodes.frame.visits, 1);
  for (const n of Object.values(d.nodes)) { assert.equal(typeof n.durationMs, 'number'); assert.ok(n.durationMs >= 0); }
  assert.equal(typeof d.durationMs, 'number');
  assert.ok(d.durationMs >= 0);
  assert.equal(d.visits.filter((x) => x.node === 'verify').length, 3);
  assert.deepEqual(d.visits.filter((x) => x.node === 'verify').map((x) => x.outcome), ['fail', 'fail', null]);
});

test('visits are stored in node_visits; ending a run closes every visit, end nodes open and close at once', async () => {
  const dir = tmp();
  const s = await open(dir);
  const id = toVerify(s);
  for (const n of ['verify', 'review', 'whitehat', 'commit', 'report']) step(s, id, n, 'pass');
  s.respond(id, { action: 'Accept', text: '' });
  step(s, id, 'pr', 'done');
  const end = s.summary(s.getRun(id));
  assert.equal(end.status, 'done');
  assert.equal(end.stage, 'done');
  assert.ok(end.endedAt);
  s.close();
  const DB = await sqlite();
  const db = new DB(path.join(dir, 'agent-monitor.db'));
  const rows = db.prepare('SELECT node_id, entered_at, left_at, outcome FROM node_visits WHERE run_id = ? ORDER BY id').all(id);
  assert.ok(rows.length >= 10);
  assert.ok(rows.every((r) => r.left_at !== null), 'a finished run has no open visit');
  const last = rows.at(-1);
  assert.equal(last.node_id, 'done');
  assert.equal(last.left_at, last.entered_at);
  db.close();
});

test('stop mid-parallel ends both branches: stopped, no active nodes, all visits closed', async () => {
  const s = await open();
  const id = toSplit(s);
  const r = s.stopRun(id).run;
  assert.equal(r.status, 'stopped');
  assert.equal(r.stage, 'stopped');
  assert.deepEqual(r.active.map((a) => a.id).filter((x) => x !== 'stopped'), []);
  assert.ok(r.endedAt);
  assert.deepEqual(JSON.parse(s.getRun(id).active_json), []);
  assert.ok(s.detail(id).visits.every((v) => v.leftAt !== null));
  assert.match(s.completeStage(id, { stage: 'implement', outcome: 'done' }).error, /already stopped/);
  assert.match(s.stopRun(id).error, /already stopped/);
});

test('respond cannot be used on a parallel run that is not waiting', async () => {
  const s = await open();
  const id = toSplit(s);
  assert.ok(s.respond(id, { action: 'Agree spec' }).error);
  assert.equal(s.respond('nope', { action: 'x' }).notFound, true);
});

test('timeline keeps recording stage and answer events', async () => {
  const s = await open();
  const id = toSplit(s);
  const kinds = s.detail(id).timeline.map((t) => t.kind);
  assert.ok(kinds.includes('stage') && kinds.includes('answer'));
});

// ---- drafts and publishing ----
const gnode = (id, extra = {}) => ({ id, type: 'step', name: id, runner: 'worker', model: 'inherit', instructions: '', position: { x: 0, y: 0 }, ...extra });
const draftOf = (nodes, edges = []) => ({ nodes, edges, loop: { maxRounds: 5, decision: 'decision' } });

test('saveDraft: size limits refuse oversize workflows, limits themselves are fine', async () => {
  const s = await open();
  const refused = (w, why) => assert.ok(s.saveDraft(w).error, `accepted: ${why}`);
  const accepted = (w, why) => assert.ok(!s.saveDraft(w).error, `refused: ${why}`);
  const many = (k) => Array.from({ length: k }, (_, i) => gnode(`n${i}`));
  refused(draftOf(many(101)), '101 nodes');
  accepted(draftOf(many(100)), '100 nodes');
  const e = (i, extra = {}) => ({ id: `e${i}`, from: 'n0', to: 'n1', on: 'done', ...extra });
  refused(draftOf(many(2), Array.from({ length: 301 }, (_, i) => e(i))), '301 edges');
  accepted(draftOf(many(2), Array.from({ length: 300 }, (_, i) => e(i))), '300 edges');
  const gate = (extra) => gnode('g', { type: 'gate', ask: 'q', actions: [{ label: 'a' }], ...extra });
  refused(draftOf([gate({ actions: Array.from({ length: 11 }, (_, i) => ({ label: `l${i}` })) })]), '11 actions');
  accepted(draftOf([gate({ actions: Array.from({ length: 10 }, (_, i) => ({ label: `l${i}` })) })]), '10 actions');
  refused(draftOf([gnode('x'.repeat(81))]), 'id 81');
  accepted(draftOf([gnode('x'.repeat(80))]), 'id 80');
  refused(draftOf([gnode('a', { name: 'n'.repeat(81) })]), 'name 81');
  refused(draftOf([gate({ actions: [{ label: 'l'.repeat(81) }] })]), 'label 81');
  refused(draftOf(many(2), [e(1, { on: 'o'.repeat(81) })]), 'on 81');
  refused(draftOf(many(2), [e(1, { id: 'i'.repeat(121) })]), 'edge id 121');
  accepted(draftOf(many(2), [e(1, { id: 'i'.repeat(120) })]), 'edge id 120');
  refused(draftOf([gate({ ask: 'q'.repeat(1001) })]), 'ask 1001');
  accepted(draftOf([gate({ ask: 'q'.repeat(1000) })]), 'ask 1000');
  refused(draftOf([gnode('a', { instructions: 'i'.repeat(4001) })]), 'instructions 4001');
  accepted(draftOf([gnode('a', { instructions: 'i'.repeat(4000) })]), 'instructions 4000');
});

test('saveDraft: not a graph at all is an error, and the stored draft is untouched', async () => {
  const s = await open();
  const before = JSON.stringify(s.draft().workflow);
  for (const bad of [null, 5, 'x', [], {}, { nodes: 'x' }]) assert.ok(s.saveDraft(bad).error, JSON.stringify(bad));
  assert.equal(JSON.stringify(s.draft().workflow), before);
});

test('saveDraft keeps an invalid draft and reports its errors as {message}', async () => {
  const s = await open();
  const bad = draftOf([gnode('a', { name: '' })]);
  const r = s.saveDraft(bad);
  assert.ok(r.draft);
  assert.ok(r.draft.errors.length > 0);
  assert.ok(r.draft.errors.every((e) => typeof e.message === 'string'));
  assert.equal(s.draft().workflow.nodes[0].id, 'a');
});

test('saveDraft stores positions', async () => {
  const s = await open();
  const w = s.draft().workflow;
  w.nodes[0].position = { x: 123, y: 456 };
  s.saveDraft(w);
  assert.deepEqual(s.draft().workflow.nodes[0].position, { x: 123, y: 456 });
});

test('publish: invalid refuses with {errors:[{message}]}; valid creates v2 and leaves running runs on v1', async () => {
  const s = await open();
  const { run } = s.startRun({ title: 'Pinned' });
  const bad = s.draft().workflow;
  bad.loop.maxRounds = 0;
  s.saveDraft(bad);
  const refused = s.publish();
  assert.ok(Array.isArray(refused.errors) && refused.errors.length > 0);
  assert.ok(refused.errors.every((e) => typeof e.message === 'string'));
  assert.equal(s.published().version, 1);
  s.resetDraft();
  const w = s.draft().workflow;
  w.nodes.find((n) => n.id === 'frame').name = 'Framing';
  s.saveDraft(w);
  assert.deepEqual(s.publish(), { version: 2 });
  assert.equal(s.published().version, 2);
  assert.equal(s.draft().baseVersion, 2);
  assert.equal(s.version(2).nodes.find((n) => n.id === 'frame').name, 'Framing');
  assert.notEqual(s.version(1).nodes.find((n) => n.id === 'frame').name, 'Framing');
  assert.equal(s.summary(s.getRun(run.id)).workflowVersion, 1);
  assert.equal(s.startRun({ title: 'New one' }).run.workflowVersion, 2);
});

test('publish refuses a graph that can push without a gate (push rule)', async () => {
  const s = await open();
  const w = s.draft().workflow;
  w.edges = w.edges.map((e) => (e.from === 'gate1' && e.on === 'Agree spec' ? { ...e, to: 'pr' } : e));
  s.saveDraft(w);
  const r = s.publish();
  assert.ok(r.errors?.length, 'gate1 Agree spec -> pr was published');
  assert.equal(s.published().version, 1);
});

test('versions(): newest first with a node count; loadVersion fills the draft', async () => {
  const s = await open();
  const w = s.draft().workflow;
  w.nodes.find((n) => n.id === 'frame').name = 'Changed';
  s.saveDraft(w); s.publish();
  const v = s.versions();
  assert.deepEqual(v.map((x) => x.version), [2, 1]);
  assert.equal(v[0].nodes, s.version(2).nodes.length);
  assert.ok(v[0].publishedAt);
  const d = s.loadVersion(1);
  assert.equal(d.workflow.nodes.find((n) => n.id === 'frame').name, s.version(1).nodes.find((n) => n.id === 'frame').name);
  assert.equal(d.baseVersion, 1);
  assert.equal(s.loadVersion(99), null);
  assert.equal(s.version(99), null);
  const r = s.resetDraft();
  assert.equal(r.baseVersion, 2);
});

test('a run pinned to a version keeps that graph: edits to the draft do not leak into it', async () => {
  const s = await open();
  const { run } = s.startRun({ title: 'Leak' });
  const w = s.draft().workflow;
  w.nodes.find((n) => n.id === 'frame').instructions = 'CHANGED';
  s.saveDraft(w);
  assert.notEqual(s.detail(run.id).workflow.nodes.find((n) => n.id === 'frame').instructions, 'CHANGED');
});
