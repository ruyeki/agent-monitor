process.env.TZ = 'Pacific/Auckland'; // UTC+13 in October: 12:00Z is already the next local day
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openUsage } from '../src/usage.js';

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'usage', 'projects');
let tmp;
let n = 0;

before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-test-')); });
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// Fresh projects dir (copy of the fixture) and data dir per test.
async function setup({ copy = true } = {}) {
  const dir = path.join(tmp, `t${n++}`);
  const projectsDir = path.join(dir, 'projects');
  const dataDir = path.join(dir, 'data');
  if (copy) fs.cpSync(FIXTURE, projectsDir, { recursive: true });
  else fs.mkdirSync(projectsDir, { recursive: true });
  const usage = await openUsage({ dataDir, projectsDir });
  return { usage, projectsDir, dataDir, main: path.join(projectsDir, '-work-alpha', 's1.jsonl') };
}

const line = (id, out, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: 's9', timestamp: '2026-10-03T00:00:00.000Z',
  message: { id, model: 'claude-opus-5', usage: { input_tokens: 1, output_tokens: out, cache_read_input_tokens: 2 } }, ...extra }) + '\n';
const byId = (usage) => Object.fromEntries(usage.messages().map((m) => [m.id, m]));

test('dedupes by message id keeping the max, skips synthetic and malformed lines', async () => {
  const { usage } = await setup();
  const r = await usage.scan();
  assert.equal(r.files, 2);
  assert.equal(r.newMessages, 5);
  const m = byId(usage);
  assert.deepEqual(Object.keys(m).sort(), ['msg_A', 'msg_B', 'msg_C', 'msg_E', 'msg_S1']);
  assert.equal(m.msg_A.output, 40); // non-adjacent repeat
  assert.equal(m.msg_B.output, 60); // adjacent repeat
  assert.deepEqual([m.msg_A.input, m.msg_A.cacheWrite, m.msg_A.cacheWrite1h, m.msg_A.cacheRead], [10, 300, 200, 1000]);
  assert.equal(m.msg_B.model, 'claude-haiku-4-5-20251001');
  assert.equal(m.msg_B.agentId, null);
  assert.equal(m.msg_B.sessionId, 's1');
  assert.equal(m.msg_S1.agentId, 'a1');
  assert.equal(usage.status().files, 2);
  assert.equal(usage.status().messages, 5);
  assert.equal(typeof usage.status().backfillMs, 'number');
  await usage.close();
});

test('a partial last line is completed on the next scan, and only new lines are read', async () => {
  const { usage, main } = await setup();
  await usage.scan();
  assert.equal(byId(usage).msg_P, undefined);
  fs.appendFileSync(main, '}}}\n');
  const r = await usage.scan();
  assert.equal(r.newMessages, 1);
  assert.equal(byId(usage).msg_P.output, 9);
  // A second scan with nothing new does nothing.
  assert.equal((await usage.scan()).newMessages, 0);
  // Incremental append: a repeat of an existing id raises its max, a new id is added.
  fs.appendFileSync(main, line('msg_P', 99) + line('msg_NEW', 4));
  const r2 = await usage.scan();
  assert.equal(r2.newMessages, 1);
  assert.equal(byId(usage).msg_P.output, 99);
  assert.equal(byId(usage).msg_NEW.output, 4);
  await usage.close();
});

test('only the appended bytes are read', async () => {
  const { usage, main } = await setup();
  await usage.scan();
  const size = fs.statSync(main).size;
  fs.appendFileSync(main, '}}}\n' + line('msg_X', 1));
  // Corrupt the already-indexed region on disk: if it were re-read, msg_A would change or break.
  const fd = fs.openSync(main, 'r+');
  fs.writeSync(fd, Buffer.from('X'.repeat(size - 10)), 0, size - 10, 0);
  fs.closeSync(fd);
  await usage.scan();
  const m = byId(usage);
  assert.equal(m.msg_A.output, 40);
  assert.equal(m.msg_X.output, 1);
  await usage.close();
});

test('a file rewritten shorter is re-read from the start without double counting', async () => {
  const { usage, main } = await setup();
  await usage.scan();
  fs.writeFileSync(main, line('msg_A', 77) + line('msg_Z', 5));
  assert.ok(fs.statSync(main).size < 1000);
  const r = await usage.scan();
  assert.equal(r.newMessages, 1);
  const m = byId(usage);
  assert.equal(m.msg_A.output, 77); // max keeps the larger of old (40) and new (77)
  assert.equal(m.msg_Z.output, 5);
  assert.equal(usage.status().messages, 6);
  await usage.close();
});

test('a new file is picked up on the next scan', async () => {
  const { usage, projectsDir } = await setup();
  await usage.scan();
  fs.mkdirSync(path.join(projectsDir, '-work-beta'));
  fs.writeFileSync(path.join(projectsDir, '-work-beta', 's2.jsonl'), line('msg_N', 3));
  const r = await usage.scan();
  assert.equal(r.files, 3);
  assert.equal(r.newMessages, 1);
  assert.equal(byId(usage).msg_N.sessionId, 's9');
  await usage.close();
});

test('symlinks and files outside the projects dir are ignored', async () => {
  const { usage, projectsDir } = await setup({ copy: false });
  const outside = path.join(tmp, `outside${n++}`);
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.jsonl'), line('msg_OUT', 1));
  fs.writeFileSync(path.join(projectsDir, 'real.jsonl'), line('msg_REAL', 1));
  fs.writeFileSync(path.join(projectsDir, 'notes.txt'), line('msg_TXT', 1));
  // File symlinks can need elevation on Windows; directory junctions do not. Try each on its own.
  let linked = 0;
  try { fs.symlinkSync(path.join(outside, 'secret.jsonl'), path.join(projectsDir, 'link.jsonl')); linked++; } catch { /* not permitted */ }
  try { fs.symlinkSync(outside, path.join(projectsDir, 'linkdir'), 'junction'); linked++; } catch { /* not permitted */ }
  const r = await usage.scan();
  assert.deepEqual(Object.keys(byId(usage)), ['msg_REAL']);
  assert.equal(r.files, 1);
  assert.ok(linked > 0, 'could not create any link, so the symlink check did not run');
  await usage.close();
});

test('day is the local date and filters work', async () => {
  const { usage } = await setup();
  await usage.scan();
  const m = byId(usage);
  assert.equal(m.msg_A.day, '2026-10-02'); // 12:00Z in UTC+13
  assert.equal(m.msg_E.day, '2026-10-01'); // 05:00Z -> 18:00 local the day before
  const d = usage.daily({ from: '2026-10-01', to: '2026-10-02' });
  assert.deepEqual(d.map((r) => `${r.day} ${r.model}`), [
    '2026-10-01 claude-sonnet-5-5', '2026-10-02 claude-haiku-4-5-20251001', '2026-10-02 claude-opus-5', '2026-10-02 claude-sonnet-5-5']);
  const opus = d.find((r) => r.model === 'claude-opus-5');
  assert.deepEqual([opus.input, opus.output, opus.cacheWrite, opus.cacheWrite1h, opus.cacheRead, opus.messages], [10, 40, 300, 200, 1000, 1]);
  assert.equal(usage.daily({ from: '2026-10-02', to: '2026-10-02' }).length, 3);
  assert.equal(usage.daily({ from: '2026-10-03', to: '2026-10-09' }).length, 0);
  assert.deepEqual(usage.messages({ agentIds: ['a1'] }).map((x) => x.id), ['msg_S1']);
  assert.equal(usage.messages({ sessionIds: ['s1'] }).length, 5);
  assert.equal(usage.messages({ sessionIds: [] }).length, 0);
  assert.deepEqual(usage.messages({ from: '2026-10-01', to: '2026-10-01' }).map((x) => x.id), ['msg_E']);
  assert.deepEqual(usage.messages({ from: '2026-10-01T12:00:06.000Z' }).map((x) => x.id), ['msg_C', 'msg_S1']);
  await usage.close();
});

test('no message content is stored', async () => {
  const { usage, dataDir } = await setup();
  await usage.scan();
  await usage.close();
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(dataDir, 'usage.db'));
  const dump = JSON.stringify([
    db.prepare('SELECT * FROM usage_messages').all(), db.prepare('SELECT * FROM usage_files').all(), db.prepare('SELECT * FROM prices').all()]);
  db.close();
  assert.doesNotMatch(dump, /SECRET|placeholder|No response requested|Bash/);
  assert.match(dump, /msg_A/);
});

test('scan does not block the event loop and scans never overlap', async () => {
  const { usage, projectsDir } = await setup({ copy: false });
  fs.mkdirSync(path.join(projectsDir, 'big'));
  const filler = JSON.stringify({ type: 'user', message: { content: 'x'.repeat(2000) } }) + '\n';
  for (let f = 0; f < 4; f++) {
    let text = '';
    for (let i = 0; i < 6000; i++) text += i % 3 === 0 ? line(`msg_${f}_${i}`, i) : filler;
    fs.writeFileSync(path.join(projectsDir, 'big', `s${f}.jsonl`), text);
  }
  let ticks = 0;
  let maxGap = 0;
  let last = Date.now();
  const timer = setInterval(() => { const t = Date.now(); maxGap = Math.max(maxGap, t - last); last = t; ticks++; }, 5);
  const p1 = usage.scan();
  const p2 = usage.scan();
  assert.equal(p1, p2);
  assert.equal(usage.status().scanning, true);
  const r = await p1;
  clearInterval(timer);
  assert.equal(r.newMessages, 8000);
  assert.ok(ticks >= 5, `only ${ticks} ticks during a ${r.ms} ms scan`);
  assert.ok(maxGap < 500, `event loop stalled ${maxGap} ms`);
  assert.equal(usage.status().scanning, false);
  await usage.close();
});

test('a line longer than the read chunk is still read', async () => {
  const { usage, projectsDir } = await setup({ copy: false });
  const long = line('msg_LONG', 8, { pad: 'y'.repeat(1.3 * 1024 * 1024) });
  fs.writeFileSync(path.join(projectsDir, 'long.jsonl'), line('msg_BEFORE', 1) + long + line('msg_AFTER', 2));
  await usage.scan();
  assert.deepEqual(Object.keys(byId(usage)).sort(), ['msg_AFTER', 'msg_BEFORE', 'msg_LONG']);
  await usage.close();
});

test('start() scans on its own, stop() halts it', async () => {
  const { usage, projectsDir } = await setup();
  usage.start({ intervalMs: 20 });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(usage.status().messages, 5);
  usage.stop();
  fs.writeFileSync(path.join(projectsDir, 'late.jsonl'), line('msg_LATE', 1));
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(usage.status().messages, 5);
  await usage.close();
});

test('prices are seeded once, validated, and edits survive a reopen', async () => {
  const { usage, projectsDir, dataDir } = await setup({ copy: false });
  const seeded = usage.prices();
  assert.ok(seeded.length >= 12);
  assert.equal(seeded.find((p) => p.model === 'claude-opus-5').output, 25);
  const bad = (rows) => assert.ok(usage.setPrices(rows).error);
  const ok = { model: 'x-1', input: 1, output: 2, cacheWrite: 3, cacheWrite1h: 4, cacheRead: 5, note: '' };
  bad('nope');
  bad([{ ...ok, input: -1 }]);
  bad([{ ...ok, output: NaN }]);
  bad([{ ...ok, cacheRead: Infinity }]);
  bad([{ ...ok, cacheWrite: '3' }]);
  bad([{ ...ok, model: '' }]);
  bad([{ ...ok, model: 'm'.repeat(81) }]);
  bad([ok, ok]);
  bad(Array.from({ length: 101 }, (_, i) => ({ ...ok, model: `m${i}` })));
  assert.equal(usage.prices().length, seeded.length, 'a rejected edit changes nothing');
  assert.equal(usage.setPrices(Array.from({ length: 100 }, (_, i) => ({ ...ok, model: `m${i}` }))).length, 100);
  const saved = usage.setPrices([ok, { ...ok, model: 'y-2', note: 'mine' }]);
  assert.deepEqual(saved.map((p) => p.model), ['x-1', 'y-2']);
  await usage.close();
  const again = await openUsage({ dataDir, projectsDir });
  assert.deepEqual(again.prices(), saved);
  assert.equal(again.setPrices([]).length, 0);
  await again.close();
  const third = await openUsage({ dataDir, projectsDir });
  assert.equal(third.prices().length, 0, 'seeds are not re-applied after the first open');
  await third.close();
});

test('totals sum per (agent, session, model) with the same filters as messages; generation bumps on every write', async () => {
  const { usage, projectsDir } = await setup({ copy: false });
  const file = path.join(projectsDir, 'p', 's9.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const at = (ts) => ({ timestamp: ts });
  fs.writeFileSync(file, [line('a', 5, at('2026-10-03T01:00:00.000Z')), line('b', 7, at('2026-10-03T02:00:00.000Z')), line('c', 1, { agentId: 'ag1', ...at('2026-10-03T03:00:00.000Z') })].join(''));
  assert.equal(usage.status().generation, 0);
  await usage.scan();
  const g1 = usage.status().generation;
  assert.ok(g1 > 0);
  await usage.scan();
  assert.equal(usage.status().generation, g1, 'a scan that writes nothing leaves the generation alone');
  const all = usage.totals();
  assert.equal(all.length, 2);
  assert.deepEqual(usage.totals({ agentNull: true }), [{ agentId: null, sessionId: 's9', model: 'claude-opus-5', input: 2, output: 12, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 4 }]);
  assert.equal(usage.totals({ agentIds: ['ag1'] })[0].output, 1);
  assert.equal(usage.totals({ agentNull: true, from: '2026-10-03T01:30:00.000Z' })[0].output, 7);
  assert.equal(usage.totals({ agentNull: true, to: '2026-10-03T01:30:00.000Z' })[0].output, 5);
  assert.deepEqual(usage.totals({ agentIds: [] }), []);
  fs.appendFileSync(file, line('d', 2, at('2026-10-03T04:00:00.000Z')));
  await usage.scan();
  assert.ok(usage.status().generation > g1);
  await usage.close();
});
