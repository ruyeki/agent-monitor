// Holdout: AC3 (old versions keep working; migration on a synthetic v1 DB and on a COPY of the live DB).
// The live files are only read with fs.copyFileSync into a temp dir; only the copy is ever opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load, tmp, fixture } from './holdout-v2-helpers.js';

const DB = async () => (await import('node:sqlite')).DatabaseSync;
const open = async (dir) => (await load('src/store.js')).openStore(dir);
const schema = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'v1-schema.sql'), 'utf8');
const T0 = Date.parse('2026-10-20T10:00:00.000Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();

// Builds a DB exactly as v1 code left it: spine v1 published, a draft, and runs at several stages.
async function v1db({ draftJson, runs } = {}) {
  const dir = tmp('am-mig-');
  const Db = await DB();
  const db = new Db(path.join(dir, 'agent-monitor.db'));
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(schema);
  const json = JSON.stringify(fixture('workflow-v1.json'));
  db.prepare('INSERT INTO workflow_versions (version, json, published_at) VALUES (1, ?, ?)').run(json, iso(0));
  db.prepare('INSERT INTO workflow_draft (id, json, updated_at, base_version) VALUES (1, ?, ?, 1)').run(draftJson ?? json, iso(0));
  const mk = (r) => {
    const status = r.status ?? 'active';
    db.prepare(`INSERT INTO runs (id, title, workflow_version, stage, round, status, ask, created_at, updated_at, ended_at)
      VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`).run(r.id, r.id, r.stage, r.round ?? 0, status, r.ask ?? null, iso(1), iso(30), ['done', 'stopped'].includes(status) ? iso(30) : null);
    const ev = db.prepare('INSERT INTO run_events (run_id, at, kind, stage, round, verdict, note) VALUES (?, ?, ?, ?, ?, ?, ?)');
    r.events.forEach(([kind, stage, verdict], i) => ev.run(r.id, iso(2 + i * 3), kind, stage, r.round ?? 0, verdict ?? null, null));
    db.prepare("INSERT INTO agents (agent_id, run_id, type, started_at) VALUES (?, ?, 'sonnet-engineer', ?)").run(`ag-${r.id}`, r.id, iso(5));
  };
  const defaults = [
    { id: 'r-impl', stage: 'implement', events: [['stage', 'frame'], ['stage', 'frame', 'done'], ['answer', 'gate1'], ['stage', 'plan', 'done']] },
    { id: 'r-gate', stage: 'gate1', status: 'waiting', ask: "What's your solution?", events: [['stage', 'frame'], ['stage', 'frame', 'done']] },
    { id: 'r-dec', stage: 'decision', status: 'waiting', ask: 'cannot reach db', events: [['stage', 'frame'], ['stage', 'frame', 'done'], ['answer', 'gate1'], ['stage', 'plan', 'done'], ['stage', 'implement', 'stuck']] },
    { id: 'r-fix', stage: 'fix', round: 2, events: [['stage', 'frame'], ['stage', 'frame', 'done'], ['answer', 'gate1'], ['stage', 'plan', 'done'], ['stage', 'implement', 'done'], ['stage', 'verify', 'fail']] },
    { id: 'r-done', stage: 'done', status: 'done', events: [['stage', 'frame'], ['stage', 'frame', 'done'], ['log', 'frame']] },
    { id: 'r-stop', stage: 'stopped', status: 'stopped', events: [['stage', 'frame'], ['stop', 'frame']] },
  ];
  for (const r of runs ?? defaults) mk(r);
  db.close();
  return dir;
}
const names = (v) => v.map((x) => x.node);

test('v1 DB: opens, publishes the seed graph as v2, and every v1 run still resolves', async () => {
  const { seedWorkflow, validateWorkflow } = await load('src/workflow.js');
  const dir = await v1db();
  const s = await open(dir);
  assert.equal(s.published().version, 2);
  assert.deepEqual(s.published().workflow, seedWorkflow());
  assert.deepEqual(s.versions().map((v) => v.version), [2, 1]);
  const v1 = s.version(1);
  assert.ok(Array.isArray(v1.nodes), 'v1 is converted to a graph on read');
  assert.deepEqual(validateWorkflow(v1), []);
  for (const id of ['r-impl', 'r-gate', 'r-dec', 'r-fix', 'r-done', 'r-stop']) {
    const sum = s.summary(s.getRun(id));
    assert.equal(sum.workflowVersion, 1, `${id} stays pinned to v1`);
    assert.ok(sum.stageName, `${id} stageName`);
    assert.ok(Array.isArray(sum.active), `${id} active`);
    const d = s.detail(id);
    assert.ok(Array.isArray(d.workflow.nodes), `${id} detail.workflow is a graph`);
  }
  const at = (id) => s.summary(s.getRun(id));
  assert.deepEqual([at('r-impl').stage, at('r-impl').status], ['implement', 'active']);
  assert.deepEqual(at('r-impl').active.map((a) => a.id), ['implement']);
  assert.deepEqual([at('r-gate').stage, at('r-gate').status, at('r-gate').ask], ['gate1', 'waiting', "What's your solution?"]);
  assert.deepEqual(at('r-gate').actions, [{ label: 'Agree spec' }, { label: 'Stop run' }]);
  assert.deepEqual([at('r-dec').stage, at('r-dec').ask], ['decision', 'cannot reach db']);
  assert.deepEqual(at('r-dec').actions, [{ label: 'Resume' }, { label: 'Stop run' }]);
  assert.deepEqual([at('r-fix').stage, at('r-fix').round], ['fix', 2]);
  assert.deepEqual([at('r-done').stage, at('r-done').status], ['done', 'done']);
  assert.deepEqual([at('r-stop').stage, at('r-stop').status], ['stopped', 'stopped']);
  assert.deepEqual(at('r-done').active.filter((a) => a.id !== 'done'), []);
  s.close();
});

test('v1 runs keep v1 behaviour after the migration', async () => {
  const s = await open(await v1db());
  // implement -> verify (v1 is linear: no parallel pair for old runs)
  let r = s.completeStage('r-impl', { stage: 'implement', outcome: 'pass' });
  assert.ok(!r.error, r.error);
  assert.equal(r.run.stage, 'verify');
  assert.deepEqual(r.run.active.map((a) => a.id), ['verify']);
  // verify fail -> fix round+1; fix pass -> verify (loop.afterFix)
  r = s.completeStage('r-impl', { stage: 'verify', outcome: 'fail', note: 'red' });
  assert.equal(r.run.stage, 'fix');
  assert.equal(r.run.round, 1);
  r = s.completeStage('r-impl', { stage: 'fix', outcome: 'pass' });
  assert.equal(r.run.stage, 'verify');
  // a fix run at round 2: fix pass -> verify, round kept
  r = s.completeStage('r-fix', { stage: 'fix', outcome: 'pass' });
  assert.equal(r.run.stage, 'verify');
  assert.equal(r.run.round, 2);
  // gate1 Agree spec -> plan; decision Resume -> plan with round 0
  r = s.respond('r-gate', { action: 'agree spec', text: 'ok' });
  assert.equal(r.run.stage, 'plan');
  r = s.respond('r-dec', { action: 'Resume', text: '' });
  assert.equal(r.run.stage, 'plan');
  assert.equal(r.run.round, 0);
  // finished runs stay finished
  assert.match(s.completeStage('r-done', { stage: 'pr', outcome: 'done' }).error, /already done/);
  assert.match(s.completeStage('r-stop', { stage: 'frame', outcome: 'done' }).error, /already stopped/);
  // wrong stage is refused with the active node
  assert.match(s.completeStage('r-gate', { stage: 'verify', outcome: 'pass' }).error, /not active|waiting/i);
  s.close();
});

test('v1 run Stop works after the migration', async () => {
  const s = await open(await v1db());
  const r = s.stopRun('r-impl');
  assert.equal(r.run.status, 'stopped');
  assert.equal(r.run.stage, 'stopped');
});

test('visits are backfilled from the event log: closed visits for what happened, one open visit for the current node', async () => {
  const s = await open(await v1db());
  const v = s.detail('r-impl').visits;
  for (const n of ['frame', 'gate1', 'plan']) assert.ok(v.some((x) => x.node === n && x.leftAt), `closed visit of ${n}`);
  const opened = v.filter((x) => x.leftAt === null);
  assert.deepEqual(names(opened), ['implement']);
  assert.ok(opened[0].enteredAt);
  assert.ok(Date.parse(v.find((x) => x.node === 'gate1').enteredAt) <= Date.parse(v.find((x) => x.node === 'gate1').leftAt));
  const g = s.detail('r-gate').visits;
  assert.deepEqual(names(g.filter((x) => x.leftAt === null)), ['gate1']);
  const dec = s.detail('r-dec').visits;
  assert.deepEqual(names(dec.filter((x) => x.leftAt === null)), ['decision']);
  const fix = s.detail('r-fix').visits;
  assert.deepEqual(names(fix.filter((x) => x.leftAt === null)), ['fix']);
  const fin = s.detail('r-done').visits;
  assert.ok(fin.every((x) => x.leftAt !== null), 'a finished run has no open visit');
  assert.ok(s.detail('r-impl').nodes.implement.visits >= 1);
  assert.equal(typeof s.detail('r-impl').durationMs, 'number');
  // log and stop events are not visits
  assert.ok(!names(s.detail('r-done').visits).includes('log'));
  s.close();
});

test('migration runs once: reopening publishes nothing new and duplicates no visits', async () => {
  const dir = await v1db();
  let s = await open(dir);
  const before = JSON.stringify(s.detail('r-impl').visits);
  const versions = s.versions().length;
  s.close();
  s = await open(dir);
  assert.equal(s.versions().length, versions);
  assert.equal(JSON.stringify(s.detail('r-impl').visits), before);
  s.close();
  const Db = await DB();
  const db = new Db(path.join(dir, 'agent-monitor.db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  db.close();
});

test('migration keeps agents and adds the new columns', async () => {
  const dir = await v1db();
  const s = await open(dir);
  const a = s.getAgent('ag-r-impl');
  assert.equal(a.run_id, 'r-impl');
  assert.ok('start_nodes' in a && 'reported_nodes' in a);
  s.close();
});

test('draft equal to the old published JSON becomes the new seed, based on the new version', async () => {
  const { seedWorkflow } = await load('src/workflow.js');
  const s = await open(await v1db());
  const d = s.draft();
  assert.deepEqual(d.workflow, seedWorkflow());
  assert.equal(d.baseVersion, 2);
  assert.deepEqual(d.errors, []);
  s.close();
});

test('an edited draft is kept (converted on read); its base version is untouched', async () => {
  const edited = fixture('workflow-v1.json');
  edited.stages.find((x) => x.id === 'plan').name = 'My own plan name';
  const s = await open(await v1db({ draftJson: JSON.stringify(edited) }));
  const d = s.draft();
  assert.ok(Array.isArray(d.workflow.nodes));
  assert.equal(d.workflow.nodes.find((n) => n.id === 'plan').name, 'My own plan name');
  assert.equal(d.baseVersion, 1);
  assert.deepEqual(d.errors, []);
  assert.equal(s.published().version, 2);
  s.close();
});

test('a draft that is the same spine but written differently (pretty-printed) still opens as a valid graph', async () => {
  const s = await open(await v1db({ draftJson: JSON.stringify(fixture('workflow-v1.json'), null, 2) }));
  const d = s.draft();
  assert.ok(Array.isArray(d.workflow.nodes));
  assert.deepEqual(d.errors, []);
  s.close();
});

test('a broken old draft does not stop the app from starting', async () => {
  const s = await open(await v1db({ draftJson: JSON.stringify({ stages: [{ id: 'x' }], loop: {} }) }));
  assert.ok(Array.isArray(s.draft().errors));
  assert.equal(s.published().version, 2);
  s.close();
});

test('a DB that already has a graph as its latest version is not migrated again', async () => {
  const dir = tmp();
  let s = await open(dir);
  const w = s.draft().workflow;
  w.nodes.find((n) => n.id === 'frame').name = 'Two';
  s.saveDraft(w); s.publish();
  s.close();
  s = await open(dir);
  assert.deepEqual(s.versions().map((v) => v.version), [2, 1]);
  s.close();
});

// ---- the live database, through a copy ----
const LIVE = path.join(os.homedir(), '.claude', 'agent-monitor');
const RUN = 'adhoc-agent-monitor-v2';

test('copy of the live DB: migrates, and the run adhoc-agent-monitor-v2 still resolves its current stage', async (t) => {
  if (!fs.existsSync(path.join(LIVE, 'agent-monitor.db'))) return t.skip('no live DB on this machine');
  const dir = tmp('am-livecopy-');
  for (const f of ['agent-monitor.db', 'agent-monitor.db-wal', 'agent-monitor.db-shm']) {
    if (fs.existsSync(path.join(LIVE, f))) fs.copyFileSync(path.join(LIVE, f), path.join(dir, f)); // read-only on the live side
  }
  const Db = await DB();
  const raw = new Db(path.join(dir, 'agent-monitor.db'));
  if (raw.prepare('PRAGMA user_version').get().user_version !== 0) { raw.close(); return t.skip('the live DB is already migrated'); }
  const before = raw.prepare('SELECT stage, status, round, workflow_version FROM runs WHERE id = ?').get(RUN);
  const nRuns = raw.prepare('SELECT COUNT(*) n FROM runs').get().n;
  const nEvents = raw.prepare('SELECT COUNT(*) n FROM run_events WHERE run_id = ?').get(RUN).n;
  raw.close();
  if (!before) return t.skip(`run ${RUN} is not in the live DB`);

  const { validateWorkflow } = await load('src/workflow.js');
  const s = await open(dir);
  try {
    const sum = s.summary(s.getRun(RUN));
    assert.equal(sum.stage, before.stage, 'the run resolves the stage it was at before the migration');
    assert.equal(sum.status, before.status);
    assert.equal(sum.round, before.round);
    if (['active', 'waiting'].includes(before.status)) assert.deepEqual(sum.active.map((a) => a.id), [before.stage]);
    assert.ok(sum.stageName);
    assert.equal(s.listRuns().length, nRuns, 'no run lost');
    for (const r of s.listRuns()) assert.ok(Array.isArray(r.active), `${r.id} resolves`);
    assert.equal(s.published().version, 2);
    assert.deepEqual(validateWorkflow(s.version(1)), [], 'the live v1 converts to a valid graph');
    assert.ok(s.detail(RUN).visits.length >= 1);
    if (['active', 'waiting'].includes(before.status)) assert.equal(s.detail(RUN).visits.filter((v) => v.leftAt === null).length, 1);
    assert.ok(nEvents >= 1);
    // The run can still be advanced by the new engine on the copy (a v1 run continues along its v1 flow).
    if (before.status === 'active') {
      const next = s.completeStage(RUN, { stage: before.stage, outcome: 'pass' });
      assert.ok(!next.error, next.error);
    }
    assert.ok(Array.isArray(s.draft().workflow.nodes));
  } finally { s.close(); }
});
