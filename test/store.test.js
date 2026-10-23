import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { seedWorkflow } from '../src/workflow.js';
import { tmp, advance } from './helpers.js';

const open = () => openStore(tmp());

test('first boot seeds published v1 and a draft equal to it', () => {
  const s = open();
  assert.equal(s.published().version, 1);
  assert.deepEqual(s.published().workflow.stages.map((x) => x.id).slice(0, 3), ['frame', 'gate1', 'plan']);
  const d = s.draft();
  assert.equal(d.baseVersion, 1);
  assert.deepEqual(d.errors, []);
  assert.deepEqual(d.workflow, s.published().workflow);
});

test('data survives a restart', () => {
  const dir = tmp();
  let s = openStore(dir);
  const { run } = s.startRun({ title: 'Survive me', task: 't' });
  s.completeStage(run.id, { stage: 'frame', outcome: 'pass', note: 'framed' });
  s.close();
  s = openStore(dir);
  const r = s.summary(s.getRun('survive-me'));
  assert.equal(r.stage, 'gate1');
  assert.equal(r.status, 'waiting');
  assert.equal(s.detail('survive-me').timeline.length, 2);
  assert.equal(s.published().version, 1);
});

test('run ids: slug argument, slugified title, collision suffixes', () => {
  const s = open();
  assert.equal(s.startRun({ title: 'Fix the Thing!' }).run.id, 'fix-the-thing');
  assert.equal(s.startRun({ title: 'Fix the Thing!' }).run.id, 'fix-the-thing-2');
  assert.equal(s.startRun({ title: 'Fix the Thing!' }).run.id, 'fix-the-thing-3');
  assert.equal(s.startRun({ title: 'x', slug: 'My Slug' }).run.id, 'my-slug');
  assert.equal(s.startRun({ title: '???' }).run.id, 'run');
  assert.match(s.startRun({ title: '  ' }).error, /title/);
});

test('start_run moves through the engine and records a timeline', () => {
  const s = open();
  const { run } = s.startRun({ title: 'A', repo: 'r', branch: 'b', note: 'hello' });
  assert.deepEqual([run.stage, run.status, run.workflowVersion, run.maxRounds, run.note], ['frame', 'active', 1, 5, 'hello']);
  const bad = s.completeStage('a', { stage: 'verify', outcome: 'pass' });
  assert.match(bad.error, /Run is at stage 'frame', not 'verify'/);
  s.completeStage('a', { stage: 'frame', outcome: 'pass' });
  const waiting = s.summary(s.getRun('a'));
  assert.deepEqual(waiting.actions, [{ label: 'Agree spec' }, { label: 'Stop run' }]);
  assert.equal(waiting.textField, true);
  assert.equal(waiting.ask, "What's your solution?");
  assert.match(s.completeStage('a', { stage: 'gate1', outcome: 'pass' }).error, /use respond/);
  assert.equal(s.completeStage('nope', { stage: 'x', outcome: 'pass' }).notFound, true);
});

test('respond stores the answer, resets the round and reaches done with an end time', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'gate2');
  const r = s.respond('a', { action: 'accept', text: 'ship it' });
  assert.equal(r.run.stage, 'pr');
  assert.deepEqual(JSON.parse(s.getRun('a').answer_json), { action: 'Accept', text: 'ship it', stage: 'gate2' });
  const done = s.completeStage('a', { stage: 'pr', outcome: 'pass' }).run;
  assert.equal(done.status, 'done');
  assert.ok(done.endedAt);
  assert.ok(s.detail('a').timeline.some((e) => e.kind === 'answer' && /ship it/.test(e.note)));
});

test('stop ends a run and rejects a second stop', () => {
  const s = open();
  s.startRun({ title: 'A' });
  const r = s.stopRun('a').run;
  assert.deepEqual([r.status, r.stage], ['stopped', 'stopped']);
  assert.match(s.stopRun('a').error, /already stopped/);
});

test('log adds a timeline entry and updates the note without moving the run', () => {
  const s = open();
  s.startRun({ title: 'A' });
  const r = s.logRun('a', 'halfway').run;
  assert.equal(r.note, 'halfway');
  assert.equal(r.stage, 'frame');
  assert.equal(s.detail('a').timeline.at(-1).kind, 'log');
});

test('draft: one draft, saved even when invalid, errors listed; publish validates', () => {
  const s = open();
  const wf = seedWorkflow();
  wf.stages = wf.stages.filter((x) => x.id !== 'verify');
  const saved = s.saveDraft(wf).draft;
  assert.ok(saved.errors.length > 0);
  assert.equal(saved.workflow.stages.length, 10);
  assert.ok(s.publish().errors.length > 0);
  assert.equal(s.published().version, 1);
  assert.ok(s.saveDraft('nope').error);
});

test('publish creates an immutable new version; versions list; load into draft; reset', () => {
  const s = open();
  const wf = seedWorkflow();
  wf.stages.find((x) => x.id === 'plan').name = 'Plan v2';
  s.saveDraft(wf);
  assert.deepEqual(s.publish(), { version: 2 });
  assert.equal(s.draft().baseVersion, 2);
  assert.equal(s.published().workflow.stages.find((x) => x.id === 'plan').name, 'Plan v2');
  assert.deepEqual(s.versions().map((v) => [v.version, v.stages]), [[2, 11], [1, 11]]);
  assert.equal(s.version(1).stages.find((x) => x.id === 'plan').name, 'Plan');
  s.loadVersion(1);
  assert.equal(s.draft().workflow.stages.find((x) => x.id === 'plan').name, 'Plan');
  assert.equal(s.draft().baseVersion, 1);
  assert.equal(s.loadVersion(99), null);
  s.resetDraft();
  assert.equal(s.draft().workflow.stages.find((x) => x.id === 'plan').name, 'Plan v2');
  assert.equal(s.draft().baseVersion, 2);
});

test('runs pin their version: publishing never alters an existing run', () => {
  const s = open();
  s.startRun({ title: 'Old' });
  const wf = seedWorkflow();
  wf.stages = wf.stages.filter((x) => x.id !== 'whitehat');
  s.saveDraft(wf);
  assert.deepEqual(s.publish(), { version: 2 });
  const fresh = s.startRun({ title: 'New' }).run;
  assert.equal(fresh.workflowVersion, 2);
  advance(s, 'old', 'review');
  assert.equal(s.completeStage('old', { stage: 'review', outcome: 'pass' }).run.stage, 'whitehat');
  advance(s, 'new', 'review');
  assert.equal(s.completeStage('new', { stage: 'review', outcome: 'pass' }).run.stage, 'commit');
  assert.equal(s.detail('old').workflow.stages.length, 11);
  assert.equal(s.detail('new').workflow.stages.length, 10);
});

test('fix loop: round counts up to the limit, then a decision; Resume restarts at resumeAt', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'verify');
  for (let round = 1; round <= 5; round++) {
    assert.equal(s.completeStage('a', { stage: 'verify', outcome: 'fail', note: 'red' }).run.round, round);
    assert.equal(s.completeStage('a', { stage: 'fix', outcome: 'pass' }).run.stage, 'verify');
  }
  const d = s.completeStage('a', { stage: 'verify', outcome: 'fail', note: 'red' }).run;
  assert.deepEqual([d.stage, d.status, d.ask], ['decision', 'waiting', 'red (fix round limit 5 reached)']);
  assert.deepEqual(d.actions, [{ label: 'Resume' }, { label: 'Stop run' }]);
  const back = s.respond('a', { action: 'Resume' }).run;
  assert.deepEqual([back.stage, back.round, back.status], ['plan', 0, 'active']);
});

test('activity is capped at 500 newest rows per run', () => {
  const s = open();
  s.startRun({ title: 'A' });
  for (let i = 0; i < 520; i++) s.addActivity('a', 'main:s', 'tool', 'Bash', `cmd ${i}`);
  assert.equal(s.activityCount('a'), 500);
  const d = s.detail('a');
  assert.equal(d.activity.length, 100);
  assert.equal(d.activity[0].summary, 'cmd 519');
});

test('saveDraft refuses oversized drafts; a draft at the limit validates without a stack overflow', () => {
  const s = open();
  const base = () => seedWorkflow();
  const stages = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'n', kind: 'step', runner: 'main', check: {} }));
  assert.match(s.saveDraft({ stages: stages(101), loop: {} }).error, /at most 100 stages/);
  assert.ok(s.saveDraft({ stages: stages(100), loop: {} }).draft);
  const wf = base();
  wf.stages[1].actions = Array.from({ length: 11 }, (_, i) => ({ label: `a${i}`, goto: 'next' }));
  assert.match(s.saveDraft(wf).error, /at most 10 actions/);
  for (const [field, len] of [['id', 81], ['name', 81], ['ask', 1001], ['instructions', 4001]]) {
    const w = base();
    w.stages[1][field] = 'x'.repeat(len);
    assert.match(s.saveDraft(w).error, new RegExp(`${field} is longer than`), field);
  }
  const w = base();
  w.stages[1].actions[0].label = 'x'.repeat(81);
  assert.match(s.saveDraft(w).error, /label is longer than 80/);
  assert.ok(s.saveDraft(base()).draft);
});
