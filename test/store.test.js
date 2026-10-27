import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { openStore } from '../src/store.js';
import { seedWorkflow, validateWorkflow, fromSpine } from '../src/workflow.js';
import { tmp, advance, fixture } from './helpers.js';

const { DatabaseSync } = await import('node:sqlite');
const open = () => openStore(tmp());
const nodeOf = (wf, id) => wf.nodes.find((x) => x.id === id);
const visitsOf = (s, id) => s.detail(id).visits.map((v) => `${v.node}:${v.outcome ?? (v.leftAt ? '-' : 'open')}`);

test('first boot seeds published v1 (the seed graph) and a draft equal to it', () => {
  const s = open();
  assert.equal(s.published().version, 1);
  assert.deepEqual(s.published().workflow, seedWorkflow());
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
  assert.deepEqual(run.active, [{ id: 'frame', name: 'Frame', type: 'step' }]);
  const bad = s.completeStage('a', { stage: 'verify', outcome: 'pass' });
  assert.equal(bad.error, "Stage 'verify' is not active. Active: frame.");
  s.completeStage('a', { stage: 'frame', outcome: 'pass' });
  const waiting = s.summary(s.getRun('a'));
  assert.deepEqual(waiting.actions, [{ label: 'Agree spec' }, { label: 'Stop run' }]);
  assert.equal(waiting.textField, true);
  assert.equal(waiting.ask, "What's your solution?");
  assert.match(s.completeStage('a', { stage: 'gate1', outcome: 'pass' }).error, /use respond/);
  assert.equal(s.completeStage('nope', { stage: 'x', outcome: 'pass' }).notFound, true);
});

test('a parallel stage: both nodes active, stage is the first, the join waits for both', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'implement');
  let r = s.summary(s.getRun('a'));
  assert.deepEqual([r.stage, r.stageName, r.active.map((x) => x.id), r.status], ['implement', 'Implement', ['implement', 'prep'], 'active']);
  r = s.completeStage('a', { stage: 'implement', outcome: 'done' }).run;
  assert.deepEqual([r.stage, r.active.map((x) => x.id)], ['prep', ['prep']]);
  assert.deepEqual(JSON.parse(s.getRun('a').joins_json), { join: ['implement>join:done'] });
  r = s.completeStage('a', { stage: 'prep', outcome: 'pass' }).run;
  assert.deepEqual([r.stage, r.active.map((x) => x.id)], ['verify', ['verify']]);
  assert.deepEqual(visitsOf(s, 'a'), ['frame:pass', 'gate1:Agree spec', 'plan:pass', 'implement:done', 'prep:pass', 'verify:open']);
});

test('respond stores the answer, resets the round and reaches done with an end time', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'gate2');
  const r = s.respond('a', { action: 'accept', text: 'ship it' });
  assert.equal(r.run.stage, 'pr');
  assert.deepEqual(JSON.parse(s.getRun('a').answer_json), { action: 'Accept', text: 'ship it', stage: 'gate2' });
  const done = s.completeStage('a', { stage: 'pr', outcome: 'pass' }).run;
  assert.deepEqual([done.status, done.stage, done.active], ['done', 'done', []]);
  assert.ok(done.endedAt);
  assert.ok(s.detail('a').timeline.some((e) => e.kind === 'answer' && /ship it/.test(e.note)));
  const end = s.detail('a').visits.at(-1);
  assert.deepEqual([end.node, end.enteredAt], ['done', end.leftAt], 'an end node is entered and left at once');
});

test('stop ends a run, closes its open visits and rejects a second stop', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'implement');
  const r = s.stopRun('a').run;
  assert.deepEqual([r.status, r.stage, r.active], ['stopped', 'stopped', []]);
  assert.match(s.stopRun('a').error, /already stopped/);
  assert.deepEqual(visitsOf(s, 'a').slice(-2), ['implement:stopped', 'prep:stopped']);
  assert.ok(s.detail('a').visits.every((v) => v.leftAt));
});

test('log adds a timeline entry and updates the note without moving the run, also after it ended', () => {
  const s = open();
  s.startRun({ title: 'A' });
  const r = s.logRun('a', 'halfway').run;
  assert.equal(r.note, 'halfway');
  assert.equal(r.stage, 'frame');
  assert.equal(s.detail('a').timeline.at(-1).kind, 'log');
  advance(s, 'a', 'pr');
  s.completeStage('a', { stage: 'pr', outcome: 'done' });
  assert.deepEqual([s.logRun('a', 'after').run.stage, s.getRun('a').status], ['done', 'done']);
});

test('detail: visits, per-node visits and time, run duration', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'verify');
  s.completeStage('a', { stage: 'verify', outcome: 'fail', note: 'red' });
  s.completeStage('a', { stage: 'fix', outcome: 'done' });
  const d = s.detail('a');
  assert.deepEqual(Object.keys(d.visits[0]).sort(), ['enteredAt', 'leftAt', 'node', 'outcome']);
  assert.equal(d.nodes.verify.visits, 2);
  assert.equal(d.nodes.fix.visits, 1);
  assert.deepEqual(d.nodes.stopped, { visits: 0, durationMs: 0 }, 'every node of the pinned graph is listed');
  assert.ok(d.nodes.frame.durationMs >= 0);
  assert.ok(d.durationMs >= 0);
  assert.deepEqual(d.workflow, s.version(1));
});

test('the decision cancels parallel branches; their visits close as cancelled', () => {
  const s = open();
  const wf = seedWorkflow();
  wf.edges.push({ id: 'implement>decision:stuck', from: 'implement', to: 'decision', on: 'stuck' });
  s.saveDraft(wf);
  assert.deepEqual(s.publish(), { version: 2 });
  s.startRun({ title: 'A' });
  advance(s, 'a', 'implement');
  const r = s.completeStage('a', { stage: 'implement', outcome: 'stuck', note: 'blocked' }).run;
  assert.deepEqual([r.stage, r.status, r.ask, r.active.map((x) => x.id)], ['decision', 'waiting', 'blocked', ['decision']]);
  assert.deepEqual(visitsOf(s, 'a').slice(-3), ['implement:stuck', 'prep:cancelled', 'decision:open']);
});

test('draft: one draft, saved even when invalid, errors listed; publish validates', () => {
  const s = open();
  const wf = seedWorkflow();
  wf.nodes = wf.nodes.filter((x) => x.id !== 'verify');
  const saved = s.saveDraft(wf).draft;
  assert.ok(saved.errors.length > 0);
  assert.ok(saved.errors.every((e) => typeof e.message === 'string'));
  assert.equal(saved.workflow.nodes.length, 17);
  assert.ok(s.publish().errors.length > 0);
  assert.equal(s.published().version, 1);
  assert.ok(s.saveDraft('nope').error);
  assert.ok(s.saveDraft({ stages: [] }).error, 'a draft must be a graph');
});

test('publish creates an immutable new version; versions list; load into draft; reset', () => {
  const s = open();
  const wf = seedWorkflow();
  nodeOf(wf, 'plan').name = 'Plan v2';
  s.saveDraft(wf);
  assert.deepEqual(s.publish(), { version: 2 });
  assert.equal(s.draft().baseVersion, 2);
  assert.equal(nodeOf(s.published().workflow, 'plan').name, 'Plan v2');
  assert.deepEqual(s.versions().map((v) => [v.version, v.nodes]), [[2, 18], [1, 18]]);
  assert.ok(s.versions().every((v) => v.publishedAt));
  assert.equal(nodeOf(s.version(1), 'plan').name, 'Plan');
  s.loadVersion(1);
  assert.equal(nodeOf(s.draft().workflow, 'plan').name, 'Plan');
  assert.equal(s.draft().baseVersion, 1);
  assert.equal(s.loadVersion(99), null);
  s.resetDraft();
  assert.equal(nodeOf(s.draft().workflow, 'plan').name, 'Plan v2');
  assert.equal(s.draft().baseVersion, 2);
});

test('runs pin their version: publishing never alters an existing run', () => {
  const s = open();
  s.startRun({ title: 'Old' });
  const wf = seedWorkflow();
  wf.nodes = wf.nodes.filter((x) => x.id !== 'whitehat');
  wf.edges.find((x) => x.from === 'review' && x.on === 'pass').to = 'commit';
  wf.edges = wf.edges.filter((x) => x.from !== 'whitehat');
  s.saveDraft(wf);
  assert.deepEqual(s.publish(), { version: 2 });
  const fresh = s.startRun({ title: 'New' }).run;
  assert.equal(fresh.workflowVersion, 2);
  advance(s, 'old', 'review');
  assert.equal(s.completeStage('old', { stage: 'review', outcome: 'pass' }).run.stage, 'whitehat');
  advance(s, 'new', 'review');
  assert.equal(s.completeStage('new', { stage: 'review', outcome: 'pass' }).run.stage, 'commit');
  assert.equal(s.detail('old').workflow.nodes.length, 18);
  assert.equal(s.detail('new').workflow.nodes.length, 17);
});

test('fix loop: round counts up to the limit, then a decision; Resume restarts at plan', () => {
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

test('agents record the active nodes when they appear and the stages they report', () => {
  const s = open();
  s.startRun({ title: 'A' });
  advance(s, 'a', 'implement');
  s.createAgent({ id: 'w1', runId: 'a', sessionId: 's', type: 'worker' });
  assert.deepEqual(JSON.parse(s.getAgent('w1').start_nodes), ['implement', 'prep']);
  assert.deepEqual(JSON.parse(s.getAgent('w1').reported_nodes), []);
  s.reportNode('w1', 'implement');
  s.reportNode('w1', 'implement');
  s.reportNode('w1', 'prep');
  s.reportNode('ghost', 'prep');
  assert.deepEqual(JSON.parse(s.getAgent('w1').reported_nodes), ['implement', 'prep']);
});

test('saveDraft refuses oversized drafts; a draft at the limit validates without a stack overflow', () => {
  const s = open();
  const base = () => seedWorkflow();
  const nodes = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${i}`, name: 'n', type: 'check', runner: 'main' }));
  const chain = (n) => Array.from({ length: n }, (_, i) => ({ id: `e${i}`, from: `s${i % 100}`, to: `s${(i + 1) % 100}`, on: '*' }));
  assert.match(s.saveDraft({ nodes: nodes(101), edges: [] }).error, /at most 100 nodes/);
  assert.match(s.saveDraft({ nodes: nodes(100), edges: chain(301) }).error, /at most 300 edges/);
  const atLimit = s.saveDraft({ nodes: nodes(100), edges: chain(300), loop: {} });
  assert.ok(atLimit.draft && atLimit.draft.errors.length > 0);
  const wf = base();
  nodeOf(wf, 'gate1').actions = Array.from({ length: 11 }, (_, i) => ({ label: `a${i}` }));
  assert.match(s.saveDraft(wf).error, /at most 10 actions/);
  for (const [field, len] of [['id', 81], ['name', 81], ['ask', 1001], ['instructions', 4001]]) {
    const w = base();
    nodeOf(w, 'gate1')[field] = 'x'.repeat(len);
    assert.match(s.saveDraft(w).error, new RegExp(`${field} is longer than`), field);
  }
  let w = base();
  nodeOf(w, 'gate1').actions[0].label = 'x'.repeat(81);
  assert.match(s.saveDraft(w).error, /label is longer than 80/);
  w = base();
  w.edges[0].id = 'x'.repeat(121);
  assert.match(s.saveDraft(w).error, /Edge id is longer than 120/);
  w = base();
  w.edges[0].on = 'x'.repeat(81);
  assert.match(s.saveDraft(w).error, /Edge on is longer than 80/);
  assert.ok(s.saveDraft(base()).draft);
});

// ---- migration from a v1 database (spine workflow, no visits)
const V1_SCHEMA = `
CREATE TABLE workflow_versions (version INTEGER PRIMARY KEY, json TEXT NOT NULL, published_at TEXT NOT NULL);
CREATE TABLE workflow_draft (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL, updated_at TEXT NOT NULL, base_version INTEGER);
CREATE TABLE runs (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, task TEXT, repo TEXT, branch TEXT, workflow_version INTEGER NOT NULL,
  stage TEXT NOT NULL, round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, verdict TEXT, ask TEXT, note TEXT,
  answer_json TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, ended_at TEXT);
CREATE TABLE run_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, at TEXT NOT NULL, kind TEXT NOT NULL,
  stage TEXT, round INTEGER, verdict TEXT, note TEXT);
CREATE TABLE agents (
  agent_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, session_id TEXT, type TEXT, model TEXT, description TEXT,
  status TEXT NOT NULL DEFAULT 'running', last_tool TEXT, last_summary TEXT, last_activity_at TEXT,
  tool_calls INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, last_error TEXT,
  waiting_permission INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  transcript_path TEXT, transcript_offset INTEGER NOT NULL DEFAULT 0, last_msg_id TEXT,
  started_at TEXT NOT NULL, finished_at TEXT, last_message TEXT);
`;
const T = (min) => new Date(Date.UTC(2026, 9, 26, 20, min)).toISOString();

// A v1 database: published spine v1, a draft, and runs at a gate, at the decision, mid-plan, done and stopped.
function v1Database({ editDraft = false } = {}) {
  const dir = tmp();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  db.exec(V1_SCHEMA);
  const json = JSON.stringify(JSON.parse(fs.readFileSync(fixture('workflow-v1.json'), 'utf8')));
  db.prepare('INSERT INTO workflow_versions VALUES (1, ?, ?)').run(json, T(0));
  const draft = editDraft ? JSON.stringify({ ...JSON.parse(json), loop: { maxRounds: 3 } }) : json;
  db.prepare('INSERT INTO workflow_draft VALUES (1, ?, ?, 1)').run(draft, T(0));
  const run = (id, stage, status, ask, ended, events) => {
    db.prepare(`INSERT INTO runs (id, title, workflow_version, stage, round, status, ask, created_at, updated_at, ended_at)
      VALUES (?, ?, 1, ?, 0, ?, ?, ?, ?, ?)`).run(id, id, stage, status, ask, T(1), T(1), ended);
    for (const [min, kind, st, verdict, note] of [[1, 'stage', 'frame', null, 'Run started'], ...events]) {
      db.prepare('INSERT INTO run_events (run_id, at, kind, stage, round, verdict, note) VALUES (?, ?, ?, ?, 0, ?, ?)').run(id, T(min), kind, st, verdict, note);
    }
  };
  const toPlan = [[2, 'stage', 'frame', 'pass', 'framed'], [3, 'answer', 'gate1', null, 'Agree spec: go']];
  run('at-gate', 'gate1', 'waiting', "What's your solution?", null, toPlan.slice(0, 1));
  run('at-plan', 'plan', 'active', null, null, [...toPlan, [4, 'log', 'plan', null, 'note']]);
  run('at-decision', 'decision', 'waiting', 'Pick A or B', null,
    [...toPlan, [5, 'stage', 'plan', 'pass', ''], [6, 'stage', 'implement', 'pass', ''], [7, 'stage', 'verify', 'stuck', 'Pick A or B']]);
  run('finished', 'done', 'done', null, T(9), [...toPlan, [8, 'answer', 'gate2', null, 'Accept'], [9, 'stage', 'pr', 'done', 'PR']]);
  run('halted', 'stopped', 'stopped', null, T(6), [...toPlan, [6, 'stop', 'plan', null, 'Stopped']]);
  db.prepare("INSERT INTO agents (agent_id, run_id, started_at) VALUES ('old-agent', 'at-plan', ?)").run(T(2));
  db.close();
  return dir;
}

test('migration: the v1 spine stays as v1 (read as a graph); the seed graph is published as v2; an untouched draft follows it', () => {
  const s = openStore(v1Database());
  assert.deepEqual(s.versions().map((v) => [v.version, v.nodes]), [[2, 18], [1, 15]]);
  assert.deepEqual(s.published().workflow, seedWorkflow());
  assert.deepEqual(s.version(1), fromSpine(JSON.parse(fs.readFileSync(fixture('workflow-v1.json'), 'utf8'))));
  assert.deepEqual(validateWorkflow(s.version(1)), []);
  assert.deepEqual([s.draft().baseVersion, s.draft().workflow], [2, seedWorkflow()]);
  assert.equal(s.loadVersion(1).workflow.nodes.length, 15, 'v1 loads into the draft as a graph');
});

test('migration: an edited draft is kept on its base and converts on read', () => {
  const s = openStore(v1Database({ editDraft: true }));
  const d = s.draft();
  assert.deepEqual([d.baseVersion, d.workflow.loop.maxRounds, d.workflow.nodes.length], [1, 3, 15]);
  assert.equal(s.published().version, 2);
});

test('migration: v1 runs keep working on their pinned v1 graph', () => {
  const s = openStore(v1Database());
  const plan = s.summary(s.getRun('at-plan'));
  assert.deepEqual([plan.stage, plan.status, plan.active], ['plan', 'active', [{ id: 'plan', name: 'Plan', type: 'step' }]]);
  assert.deepEqual(s.completeStage('at-plan', { stage: 'plan', outcome: 'pass' }).run.active.map((a) => a.id), ['implement']);
  const gate = s.summary(s.getRun('at-gate'));
  assert.deepEqual([gate.stage, gate.status, gate.actions.map((a) => a.label)], ['gate1', 'waiting', ['Agree spec', 'Stop run']]);
  const dec = s.summary(s.getRun('at-decision'));
  assert.deepEqual([dec.stage, dec.ask, dec.actions.map((a) => a.label)], ['decision', 'Pick A or B', ['Resume', 'Stop run']]);
  const resumed = s.respond('at-decision', { action: 'Resume' }).run;
  assert.deepEqual([resumed.stage, resumed.status, resumed.round], ['plan', 'active', 0]);
  assert.deepEqual([s.summary(s.getRun('finished')).active, s.summary(s.getRun('halted')).stage], [[], 'stopped']);
  assert.equal(s.startRun({ title: 'New' }).run.workflowVersion, 2);
});

test('migration: visits are backfilled from the v1 timeline', () => {
  const s = openStore(v1Database());
  const v = (id) => s.detail(id).visits.map((x) => [x.node, x.enteredAt, x.leftAt, x.outcome]);
  assert.deepEqual(v('at-decision'), [
    ['frame', T(1), T(2), 'pass'], ['gate1', T(2), T(3), 'Agree spec'], ['plan', T(3), T(5), 'pass'],
    ['implement', T(5), T(6), 'pass'], ['verify', T(6), T(7), 'stuck'], ['decision', T(7), null, null],
  ]);
  assert.deepEqual(v('at-gate').at(-1), ['gate1', T(2), null, null]);
  assert.deepEqual(v('at-plan').at(-1), ['plan', T(3), null, null], 'a log does not end a visit');
  assert.deepEqual(v('finished').slice(-3), [['gate2', T(3), T(8), 'Accept'], ['pr', T(8), T(9), 'done'], ['done', T(9), T(9), null]]);
  assert.deepEqual(v('halted').at(-1), ['plan', T(3), T(6), 'stopped'], 'a REST stop closes the visit, no end visit');
  assert.equal(s.detail('at-decision').nodes.verify.visits, 1);
  assert.equal(s.detail('at-decision').nodes.verify.durationMs, 60000);
});

test('migration: runs once, adds the new agent columns, and survives a reopen', () => {
  const dir = v1Database();
  let s = openStore(dir);
  s.reportNode('old-agent', 'plan');
  assert.deepEqual(JSON.parse(s.getAgent('old-agent').reported_nodes), ['plan']);
  assert.equal(s.getAgent('old-agent').start_nodes, null);
  const visits = s.detail('at-decision').visits.length;
  s.close();
  s = openStore(dir);
  assert.equal(s.detail('at-decision').visits.length, visits);
  assert.equal(s.versions().length, 2);
  s.close();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();
});
