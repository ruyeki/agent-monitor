// Holdouts for the Codex store ops, the usage indexer additions, the transcript limit backup (AC1) and the config place (AC8/one place).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { REPO, load, tmp, sleep, until, bootCodex, started } from './holdout-codex-helpers.js';

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const newStore = async (dir = tmp('amx-st-')) => { const { openStore } = await load('src/store.js'); return openStore(dir); };

test('store: a v2 database opens, gains the new columns and still works', async () => {
  const dir = tmp('amx-v2-');
  fs.copyFileSync(path.join(import.meta.dirname, 'fixtures', 'codex-v2.db'), path.join(dir, 'agent-monitor.db'));
  const store = await newStore(dir);
  try {
    const run = store.getRun('old-run');
    assert.ok(run, 'old run survives');
    const s = store.summary(run);
    assert.ok(s.provider === 'claude' || s.provider == null);
    assert.equal(s.limitAt ?? null, null);
    assert.ok(store.markLimit('old-run', { at: iso(), resetsAt: null, source: 'stopfailure' }));
    store.close();
  } finally { /* closed above */ }
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  try {
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 3);
    const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
    for (const c of ['provider', 'codex_thread_id', 'limit_at', 'resets_at', 'limit_source', 'cwds_json']) assert.ok(cols('runs').includes(c), `runs.${c}`);
    assert.ok(cols('node_visits').includes('provider'));
    assert.ok(cols('agents').includes('provider'));
  } finally { db.close(); }
});

test('store.markLimit: first call wins atomically; a second fills only a missing reset time; ended and Codex runs refuse', async () => {
  const store = await newStore();
  try {
    const id = store.startRun({ title: 'A' }).run.id;
    assert.equal(store.markLimit(id, { at: iso(), resetsAt: null, source: 'transcript' }), true);
    assert.equal(store.markLimit(id, { at: iso(), resetsAt: iso(Date.now() + 3600e3), source: 'stopfailure' }), false);
    let s = store.summary(store.getRun(id));
    assert.equal(s.limitSource, 'transcript', 'first source kept');
    assert.ok(s.resetsAt, 'missing reset time filled by the second call');
    const first = s.resetsAt;
    store.markLimit(id, { at: iso(), resetsAt: iso(Date.now() + 9e6), source: 'stopfailure' });
    assert.equal(store.summary(store.getRun(id)).resetsAt, first, 'an existing reset time is not overwritten');
    const b = store.startRun({ title: 'B' }).run.id;
    store.stopRun(b);
    assert.equal(store.markLimit(b, { at: iso(), resetsAt: null, source: 'stopfailure' }), false, 'stopped run');
    const c = store.startRun({ title: 'C' }).run.id;
    store.handOver(c);
    assert.equal(store.markLimit(c, { at: iso(), resetsAt: null, source: 'stopfailure' }), false, 'run already on Codex');
  } finally { store.close(); }
});

test('store.handOver / setCodexThread / escalate / releaseSession', async () => {
  const store = await newStore();
  try {
    const id = store.startRun({ title: 'H' }).run.id;
    store.linkSession('sess-x', id);
    store.handOver(id);
    let s = store.summary(store.getRun(id));
    assert.equal(s.provider, 'codex');
    assert.ok(store.detail(id).visits.filter((v) => !v.leftAt).every((v) => v.provider === 'codex'));
    store.setCodexThread(id, 'thr-9');
    assert.equal(store.summary(store.getRun(id)).codexThreadId, 'thr-9');
    assert.equal(store.sessionRun('thr-9')?.id, id, 'thread id is linked as a session');
    store.releaseSession('sess-x');
    assert.ok(!store.sessionRun('sess-x'), 'a handed-over run no longer holds the Claude session');
    const r = store.escalate(id, 'Codex failed: x');
    assert.ok(!r?.error);
    s = store.summary(store.getRun(id));
    assert.equal(s.stage, 'decision');
    assert.equal(s.status, 'waiting');
    assert.ok(String(s.ask).includes('Codex failed: x'));
    assert.ok(store.detail(id).visits.some((v) => v.node === 'frame' && v.outcome === 'escalated'), 'open visit closed as escalated');
    store.stopRun(id);
    assert.ok(store.escalate(id, 'late').error, 'cannot escalate an ended run');
  } finally { store.close(); }
});

test('store.releaseSession: frees a stopped run, keeps a live Claude run linked', async () => {
  const store = await newStore();
  try {
    const live = store.startRun({ title: 'live' }).run.id;
    store.linkSession('s-live', live);
    store.releaseSession('s-live');
    assert.equal(store.sessionRun('s-live')?.id, live, 'live Claude run stays linked');
    const st = store.startRun({ title: 'stopped' }).run.id;
    store.linkSession('s-stop', st);
    store.stopRun(st);
    store.releaseSession('s-stop');
    assert.ok(!store.sessionRun('s-stop', { adoptStopped: true }), 'stopped run released');
  } finally { store.close(); }
});

test('store.noteCwd: distinct, most recent first, capped at 5, tolerant of junk', async () => {
  const dir = tmp('amx-cwd-');
  const store = await newStore(dir);
  let id;
  try {
    id = store.startRun({ title: 'cwd' }).run.id;
    for (const c of ['C:/a', 'C:/b', 'C:/c', 'C:/d', 'C:/e', 'C:/f']) store.noteCwd(id, c);
    store.noteCwd(id, 'C:/d'); // moves to the front, no duplicate
    store.noteCwd(id, 5); store.noteCwd(id, ''); store.noteCwd(id, 'x'.repeat(5000)); store.noteCwd(id, null);
  } finally { store.close(); }
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  try {
    const list = JSON.parse(db.prepare('SELECT cwds_json FROM runs WHERE id = ?').get(id).cwds_json);
    assert.equal(list.length, 5);
    assert.equal(list[0], 'C:/d');
    assert.equal(new Set(list.map((x) => x.toLowerCase())).size, 5);
    assert.ok(list.every((x) => typeof x === 'string' && x.length <= 1000));
    assert.ok(!list.includes('C:/a'), 'oldest dropped at the cap');
  } finally { db.close(); }
});

test('usage: addCodexTurn stores a Codex row apart from Claude rows; daily gains a provider', async () => {
  const { openUsage } = await load('src/usage.js');
  const dataDir = tmp('amx-u-'); const projects = tmp('amx-p-');
  const u = await openUsage({ dataDir, projectsDir: projects });
  try {
    const at = Date.now();
    u.addCodexTurn({ runId: 'r1', threadId: 'thr', model: 'gpt-5.6-sol', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50, reasoning_output_tokens: 7 }, at });
    u.addCodexTurn({ runId: 'r1', threadId: 'thr', model: 'gpt-5.6-sol', usage: { input_tokens: 10, cached_input_tokens: 50, output_tokens: 1, reasoning_output_tokens: 0 }, at });
    const rows = u.codexTotals('r1');
    const sum = (k) => rows.reduce((n, r) => n + (r[k] ?? 0), 0);
    assert.equal(sum('input'), 600 + 0, 'input excludes cached; never negative');
    assert.equal(sum('cacheRead'), 450);
    assert.equal(sum('output'), 51);
    assert.ok(rows.every((r) => r.model === 'gpt-5.6-sol'));
    assert.deepEqual(u.codexTotals('other-run'), []);
    assert.equal(u.messages({}).length, 0, 'Claude message list never sees Codex rows');
    const day = new Date(at); const d = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
    const daily = u.daily({ from: d, to: d });
    assert.ok(daily.some((r) => r.provider === 'codex' && r.model === 'gpt-5.6-sol'));
    assert.ok(!daily.some((r) => (r.provider ?? 'claude') === 'claude'));
  } finally { await u.close(); }
});

const limitLine = (o = {}) => JSON.stringify({
  type: 'assistant', error: 'rate_limit', isApiErrorMessage: true, apiErrorStatus: 429, sessionId: 'sx', cwd: 'C:\\x',
  timestamp: iso(), quotaLimits: { resetsAt: 1791655200 }, apiErrorParams: { rate_limit_info: { resetsAt: 1791655200 } },
  message: { id: 'm1', model: '<synthetic>', role: 'assistant', content: [{ type: 'text', text: 'limit' }], usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } }, ...o,
});

test('usage limit backup: fresh rate_limit entries are reported, old / other errors are not, synthetic rows are not counted', async () => {
  const { openUsage } = await load('src/usage.js');
  const dataDir = tmp('amx-u-'); const projects = tmp('amx-p-');
  const dir = path.join(projects, 'proj');
  fs.mkdirSync(path.join(dir, 'sx', 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'sx.jsonl'), [
    limitLine(), // fresh main hit
    limitLine({ timestamp: iso(Date.now() - 2 * 3600e3), sessionId: 'sold' }), // old
    limitLine({ error: 'authentication_failed', sessionId: 'sauth' }),
    limitLine({ isApiErrorMessage: false, sessionId: 'snotapi' }),
    limitLine({ error: 'rate_limit_exceeded', sessionId: 'sother' }),
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'sx', 'subagents', 'agent-ag1.jsonl'), limitLine({ agentId: 'ag1' }) + '\n');
  const u = await openUsage({ dataDir, projectsDir: projects });
  const hits = [];
  try {
    u.start({ intervalMs: 100, onLimit: (h) => hits.push(h), onScan: () => {} });
    await until(() => hits.length >= 2, 20000);
    await sleep(400);
    assert.ok(hits.some((h) => h.sessionId === 'sx' && !h.agentId), 'main hit');
    assert.ok(hits.some((h) => h.agentId === 'ag1'), 'subagent hit carries the agent id');
    assert.ok(hits.every((h) => h.sessionId === 'sx'), 'old / non-rate-limit / non-API entries ignored');
    assert.equal(new Date(hits[0].resetsAt).getTime(), 1791655200 * 1000);
    assert.equal(u.messages({}).length, 0, 'synthetic limit rows are never counted as usage');
  } finally { u.stop(); await u.close(); }
});

test('AC1 backup end to end: a fresh transcript limit entry of a linked session hands the run off within ~10 s', async () => {
  const a = await bootCodex({ repos: ['repoA'] });
  try {
    const id = await a.startRun('Backup', { repo: 'repoA' });
    await a.link('s-bk', id);
    const dir = path.join(a.projects, 'proj'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 's-bk.jsonl'), limitLine({ sessionId: 's-bk', cwd: path.join(a.root, 'repoA') }) + '\n');
    const d = await until(async () => { const x = (await a.detail(id)).run; return x.provider === 'codex' && x; }, 20000);
    assert.ok(d, 'handed off from the transcript hit');
    assert.equal(d.limitSource, 'transcript');
    assert.equal(new Date(d.resetsAt).getTime(), 1791655200 * 1000);
    assert.ok(await until(() => a.calls().length >= 1), 'Codex launched');
    // an old hit from an unrelated session never marks anything
    const id2 = await a.startRun('Old', { repo: 'repoA' });
    await a.link('s-old', id2);
    fs.writeFileSync(path.join(dir, 's-old.jsonl'), limitLine({ sessionId: 's-old', timestamp: iso(Date.now() - 3 * 3600e3) }) + '\n');
    await sleep(1500);
    assert.ok(!(await a.detail(id2)).run.limitAt);
  } finally { await a.close(); }
});

test('one config place: model names, astra, fast tiers and auth.json appear nowhere else in the code', async () => {
  const cfg = await load('src/codex-config.js');
  assert.deepEqual(cfg.checkCodexConfig(), []);
  assert.ok(cfg.checkCodexConfig({ roles: { x: { model: 'gpt-6-astra', effort: 'high' } } }).length > 0);
  assert.ok(cfg.checkCodexConfig({ roles: { x: { model: 'gpt-5.6-sol', effort: 'ultra' } } }).length > 0);
  assert.ok(cfg.checkCodexConfig({ roles: { x: { model: 'gpt-5.6-sol', effort: 'high', tier: 'ultrafast' } } }).length > 0);
  assert.ok(cfg.checkCodexConfig({ handoff: { model: 'fast', effort: 'low' } }).length > 0);
  assert.deepEqual(Object.keys(cfg.ROLES).sort(), ['fable-lead', 'haiku-engineer', 'opus-engineer', 'sonnet-engineer', 'verifier', 'white-hat']);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]));
  for (const f of [...walk(path.join(REPO, 'src')), ...walk(path.join(REPO, 'bin')), ...walk(path.join(REPO, 'scripts'))].filter((p) => /\.(js|mjs)$/.test(p))) {
    if (f.replaceAll('\\', '/').endsWith('src/codex-config.js')) continue;
    const t = fs.readFileSync(f, 'utf8');
    assert.ok(!/gpt-\d/i.test(t), `${path.relative(REPO, f)} hard-codes a model name`);
    assert.ok(!/astra/i.test(t), `${path.relative(REPO, f)} mentions astra`);
    assert.ok(!/auth\.json/i.test(t), `${path.relative(REPO, f)} names auth.json`);
  }
});
