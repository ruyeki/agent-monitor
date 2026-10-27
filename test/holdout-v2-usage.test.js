// Holdout (phase B module pins): AC10 usage indexer (src/usage.js) and the price table (src/prices.js).
// Fixture transcripts are written to temp dirs. The real ~/.claude/projects is never read here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { load, tmp, sleep, until } from './holdout-v2-helpers.js';

const U = () => load('src/usage.js');
const P = () => load('src/prices.js');

const usage = (o = {}) => ({
  input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000,
  cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 40 }, ...o,
});
const line = ({ id, ts = '2026-10-20T12:00:00.000Z', session = 'sess-1', agent, model = 'claude-sonnet-5-5-20261001', u = usage(), content = 'hello', type = 'assistant' }) => JSON.stringify({
  type, sessionId: session, ...(agent ? { agentId: agent } : {}), timestamp: ts,
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: content }], usage: u },
});
const write = (file, lines, { eol = true } = {}) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.join('\n') + (eol ? '\n' : '')); };
const append = (file, lines, { eol = true } = {}) => fs.appendFileSync(file, lines.join('\n') + (eol ? '\n' : ''));

async function setup() {
  const { openUsage } = await U();
  const projectsDir = tmp('am-proj-');
  const dataDir = tmp('am-data-');
  const open = () => openUsage({ dataDir, projectsDir });
  const ix = await open();
  return { ix, projectsDir, dataDir, open, main: path.join(projectsDir, 'proj-a', 'sess-1.jsonl'), sub: (aid) => path.join(projectsDir, 'proj-a', 'sess-1', 'subagents', `agent-${aid}.jsonl`) };
}
const byId = (rows) => Object.fromEntries(rows.map((r) => [r.id, r]));

test('openUsage exposes the pinned API and creates usage.db in dataDir', async () => {
  const t = await setup();
  for (const k of ['scan', 'start', 'stop', 'close', 'status', 'messages', 'daily', 'prices', 'setPrices']) assert.equal(typeof t.ix[k], 'function', k);
  assert.ok(fs.existsSync(path.join(t.dataDir, 'usage.db')));
  t.ix.close();
});

test('scan: one row per message with the pinned fields; main has agentId null, subagents carry theirs', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'm1' }), line({ id: 'm2', model: 'claude-opus-5-5-20261001', u: usage({ input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }) })]);
  write(t.sub('abc'), [line({ id: 's1', agent: 'abc', u: usage({ output_tokens: 99 }) })]);
  const r = await t.ix.scan();
  assert.equal(r.newMessages, 3);
  assert.ok(r.files >= 2);
  assert.equal(typeof r.ms, 'number');
  const rows = byId(t.ix.messages({}));
  assert.equal(Object.keys(rows).length, 3);
  assert.deepEqual(Object.keys(rows.m1).sort(), ['agentId', 'cacheRead', 'cacheWrite', 'cacheWrite1h', 'day', 'id', 'input', 'model', 'output', 'sessionId', 'ts'].sort());
  assert.equal(rows.m1.agentId, null);
  assert.equal(rows.m1.sessionId, 'sess-1');
  assert.equal(rows.m1.model, 'claude-sonnet-5-5-20261001');
  assert.deepEqual([rows.m1.input, rows.m1.output, rows.m1.cacheWrite, rows.m1.cacheWrite1h, rows.m1.cacheRead], [10, 5, 100, 40, 1000]);
  assert.equal(rows.s1.agentId, 'abc');
  assert.equal(rows.s1.output, 99);
  assert.equal(new Date(rows.m1.ts).toISOString(), '2026-10-20T12:00:00.000Z');
  assert.equal(rows.m2.model, 'claude-opus-5-5-20261001');
  t.ix.close();
});

test('a message id repeated once per content block counts once and keeps the MAX of each field', async () => {
  const t = await setup();
  write(t.main, [
    line({ id: 'm1', u: usage({ output_tokens: 5 }) }),
    line({ id: 'm1', u: usage({ output_tokens: 12 }) }),
    line({ id: 'm2', u: usage({ output_tokens: 1 }) }),
    line({ id: 'm1', u: usage({ output_tokens: 40 }) }), // non-adjacent repeat with the final count
    line({ id: 'm1', u: usage({ output_tokens: 30 }) }), // a stale smaller count never lowers it
  ]);
  const r = await t.ix.scan();
  assert.equal(r.newMessages, 2);
  const rows = byId(t.ix.messages({}));
  assert.equal(Object.keys(rows).length, 2);
  assert.equal(rows.m1.output, 40);
  assert.equal(rows.m1.input, 10, 'input is not multiplied by the repeats');
  assert.equal(rows.m1.cacheRead, 1000);
  t.ix.close();
});

test('a repeat that arrives in a LATER scan raises the stored count, adds no row', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'm1', u: usage({ output_tokens: 5 }) })]);
  await t.ix.scan();
  append(t.main, [line({ id: 'm1', u: usage({ output_tokens: 77 }) })]);
  const r = await t.ix.scan();
  assert.equal(r.newMessages, 0);
  assert.equal(t.ix.messages({}).length, 1);
  assert.equal(t.ix.messages({})[0].output, 77);
  t.ix.close();
});

test('skips <synthetic>, lines without usage, non-JSON lines and messages without an id', async () => {
  const t = await setup();
  write(t.main, [
    line({ id: 'syn', model: '<synthetic>' }),
    JSON.stringify({ type: 'user', sessionId: 'sess-1', timestamp: '2026-10-20T12:00:00.000Z', message: { role: 'user', content: 'hi' } }),
    '{ this is not json "usage"',
    '',
    JSON.stringify({ type: 'assistant', sessionId: 'sess-1', timestamp: '2026-10-20T12:00:00.000Z', message: { model: 'claude-sonnet-5-5', usage: usage() } }),
    line({ id: 'good' }),
  ]);
  await t.ix.scan();
  assert.deepEqual(t.ix.messages({}).map((m) => m.id), ['good']);
  t.ix.close();
});

test('incremental: an unchanged tree scans nothing new; growth reads only the new lines; offsets survive a reopen', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a' }), line({ id: 'b' })]);
  assert.equal((await t.ix.scan()).newMessages, 2);
  assert.equal((await t.ix.scan()).newMessages, 0);
  append(t.main, [line({ id: 'c' })]);
  assert.equal((await t.ix.scan()).newMessages, 1);
  t.ix.close();
  const again = await t.open();
  assert.equal((await again.scan()).newMessages, 0, 'the offset is persisted');
  append(t.main, [line({ id: 'd' })]);
  assert.equal((await again.scan()).newMessages, 1);
  assert.equal(again.messages({}).length, 4);
  again.close();
});

test('only complete lines are consumed: a half-written last line waits for its newline', async () => {
  const t = await setup();
  const second = line({ id: 'b' });
  write(t.main, [line({ id: 'a' })]);
  fs.appendFileSync(t.main, second.slice(0, 60));
  assert.equal((await t.ix.scan()).newMessages, 1);
  fs.appendFileSync(t.main, second.slice(60) + '\n');
  assert.equal((await t.ix.scan()).newMessages, 1);
  assert.deepEqual(t.ix.messages({}).map((m) => m.id).sort(), ['a', 'b']);
  t.ix.close();
});

test('a last line without a newline is stored once its newline arrives, and never twice', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a' })], { eol: false });
  await t.ix.scan();
  fs.appendFileSync(t.main, `
${line({ id: 'b' })}
`);
  await t.ix.scan();
  assert.deepEqual(t.ix.messages({}).map((m) => m.id).sort(), ['a', 'b']);
  await t.ix.scan();
  assert.equal(t.ix.messages({}).length, 2);
  t.ix.close();
});

test('truncation: a file that shrinks is re-read from the start without double counting', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a', content: 'x'.repeat(300) }), line({ id: 'b', content: 'x'.repeat(300) }), line({ id: 'c', content: 'x'.repeat(300) })]);
  await t.ix.scan();
  write(t.main, [line({ id: 'a' })]); // rotated: smaller than the stored offset
  const r = await t.ix.scan();
  assert.equal(r.newMessages, 0);
  assert.equal(t.ix.messages({}).length, 3);
  t.ix.close();
});

test('truncation: after the shrink, a new message in the restarted file is picked up', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a', content: 'x'.repeat(300) }), line({ id: 'b', content: 'x'.repeat(300) })]);
  await t.ix.scan();
  write(t.main, [line({ id: 'z' })]);
  assert.equal((await t.ix.scan()).newMessages, 1);
  assert.deepEqual(t.ix.messages({}).map((m) => m.id).sort(), ['a', 'b', 'z']);
  t.ix.close();
});

test('new files and new directories are picked up on the next scan; non-.jsonl files are ignored', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a' })]);
  await t.ix.scan();
  write(path.join(t.projectsDir, 'proj-b', 'other.jsonl'), [line({ id: 'n1', session: 'other' })]);
  write(path.join(t.projectsDir, 'proj-b', 'notes.txt'), [line({ id: 'txt' })]);
  write(path.join(t.projectsDir, 'proj-b', 'x.jsonl.bak'), [line({ id: 'bak' })]);
  const r = await t.ix.scan();
  assert.equal(r.newMessages, 1);
  assert.deepEqual(t.ix.messages({}).map((m) => m.id).sort(), ['a', 'n1']);
  t.ix.close();
});

test('symlinks are skipped and nothing outside the projects dir is read', async (tc) => {
  const t = await setup();
  const outside = path.join(tmp('am-outside-'), 'secret.jsonl');
  write(outside, [line({ id: 'outside' })]);
  try { fs.symlinkSync(outside, path.join(t.projectsDir, 'link.jsonl')); } catch { return tc.skip('cannot create symlinks here'); }
  write(t.main, [line({ id: 'inside' })]);
  await t.ix.scan();
  assert.deepEqual(t.ix.messages({}).map((m) => m.id), ['inside']);
  t.ix.close();
});

test('a line longer than any read chunk is still read', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'big', content: 'y'.repeat(3 * 1024 * 1024) }), line({ id: 'after' })]);
  await t.ix.scan();
  assert.deepEqual(t.ix.messages({}).map((m) => m.id).sort(), ['after', 'big']);
  t.ix.close();
});

test('no message content is stored: a marker in the text never reaches usage.db or its WAL', async () => {
  const t = await setup();
  const marker = 'ZQX-PRIVATE-MARKER-7731';
  write(t.main, [line({ id: 'm1', content: `${marker} please keep this secret` }), JSON.stringify({
    type: 'assistant', sessionId: 'sess-1', timestamp: '2026-10-20T12:00:00.000Z',
    message: { id: 'm2', model: 'claude-sonnet-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: `echo ${marker}` } }], usage: usage() },
  })]);
  await t.ix.scan();
  t.ix.close();
  for (const f of fs.readdirSync(t.dataDir)) {
    const bytes = fs.readFileSync(path.join(t.dataDir, f));
    assert.ok(!bytes.includes(marker), `${f} contains message content`);
  }
});

test('day is the LOCAL date of the timestamp (honours TZ)', async () => {
  const prev = process.env.TZ;
  try {
    for (const [tz, day] of [['Pacific/Auckland', '2026-10-27'], ['America/Los_Angeles', '2026-10-26'], ['UTC', '2026-10-26']]) {
      process.env.TZ = tz;
      const t = await setup();
      write(t.main, [line({ id: 'edge', ts: '2026-10-26T23:30:00.000Z' })]);
      await t.ix.scan();
      assert.equal(t.ix.messages({})[0].day, day, tz);
      t.ix.close();
    }
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
});

test('messages(): filter by agent ids and session ids', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'm1' })]);
  write(t.sub('a1'), [line({ id: 's1', agent: 'a1' })]);
  write(t.sub('a2'), [line({ id: 's2', agent: 'a2' })]);
  write(path.join(t.projectsDir, 'proj-a', 'sess-2.jsonl'), [line({ id: 'o1', session: 'sess-2' })]);
  await t.ix.scan();
  const ids = (q) => t.ix.messages(q).map((m) => m.id).sort();
  assert.deepEqual(ids({ agentIds: ['a1'] }), ['s1']);
  assert.deepEqual(ids({ agentIds: ['a1', 'a2'] }), ['s1', 's2']);
  assert.deepEqual(ids({ sessionIds: ['sess-2'] }), ['o1']);
  assert.deepEqual(ids({ sessionIds: ['sess-1'] }), ['m1', 's1', 's2']);
  assert.deepEqual(ids({ agentIds: ['nobody'] }), []);
  assert.equal(ids({}).length, 4);
  t.ix.close();
});

test('daily(): sums per day and model, inclusive bounds, counts messages once', async () => {
  const t = await setup();
  const prev = process.env.TZ;
  process.env.TZ = 'UTC';
  try {
    write(t.main, [
      line({ id: 'a', ts: '2026-10-20T01:00:00Z', u: usage({ input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 } }) }),
      line({ id: 'a', ts: '2026-10-20T01:00:00Z', u: usage({ input_tokens: 1, output_tokens: 3, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, cache_creation: { ephemeral_5m_input_tokens: 6, ephemeral_1h_input_tokens: 4 } }) }),
      line({ id: 'b', ts: '2026-10-20T23:00:00Z', u: usage({ input_tokens: 5, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } }) }),
      line({ id: 'c', ts: '2026-10-21T10:00:00Z', model: 'claude-opus-5-5-20261001' }),
      line({ id: 'd', ts: '2026-10-22T10:00:00Z' }),
    ]);
    await t.ix.scan();
    const rows = t.ix.daily({ from: '2026-10-20', to: '2026-10-21' });
    assert.equal(rows.length, 2, JSON.stringify(rows));
    const d20 = rows.find((r) => r.day === '2026-10-20');
    assert.equal(d20.model, 'claude-sonnet-5-5-20261001');
    assert.deepEqual([d20.input, d20.output, d20.cacheWrite, d20.cacheWrite1h, d20.cacheRead, d20.messages], [6, 8, 10, 4, 100, 2]);
    const d21 = rows.find((r) => r.day === '2026-10-21');
    assert.equal(d21.model, 'claude-opus-5-5-20261001');
    assert.equal(d21.messages, 1);
    assert.equal(t.ix.daily({ from: '2026-10-22', to: '2026-10-22' }).length, 1);
    assert.equal(t.ix.daily({ from: '2026-11-01', to: '2026-11-30' }).length, 0);
  } finally { if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev; }
  t.ix.close();
});

test('status(): file and message counts, scanning flag, last scan and backfill timings', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a' }), line({ id: 'b' })]);
  write(t.sub('q'), [line({ id: 'c', agent: 'q' })]);
  assert.equal(t.ix.status().scanning, false);
  await t.ix.scan();
  const s = t.ix.status();
  assert.deepEqual([s.files, s.messages, s.scanning], [2, 3, false]);
  assert.ok(s.lastScanAt);
  assert.equal(typeof s.lastScanMs, 'number');
  assert.equal(typeof s.backfillMs, 'number');
  t.ix.close();
});

test('scans never overlap: concurrent scan() calls leave exactly one row per message', async () => {
  const t = await setup();
  write(t.main, Array.from({ length: 400 }, (_, i) => line({ id: `m${i}` })));
  const res = await Promise.all([t.ix.scan(), t.ix.scan(), t.ix.scan()]);
  assert.ok(res.every((r) => r.newMessages === 0 || r.newMessages === 400), 'a scan reports either everything (it ran, or shared the running one) or nothing');
  assert.ok(res.some((r) => r.newMessages === 400));
  assert.equal(t.ix.messages({}).length, 400);
  t.ix.close();
});

test('start() keeps the index current, stop() ends it', async () => {
  const t = await setup();
  write(t.main, [line({ id: 'a' })]);
  t.ix.start({ intervalMs: 80 });
  assert.ok(await until(() => t.ix.messages({}).length === 1, 3000), 'first backfill');
  append(t.main, [line({ id: 'b' })]);
  write(path.join(t.projectsDir, 'proj-z', 'new.jsonl'), [line({ id: 'c', session: 'new' })]);
  assert.ok(await until(() => t.ix.messages({}).length === 3, 3000), 'growth and new file are picked up');
  t.ix.stop();
  await sleep(200);
  append(t.main, [line({ id: 'd' })]);
  await sleep(400);
  assert.equal(t.ix.messages({}).length, 3, 'nothing is indexed after stop()');
  t.ix.close();
});

test('a big backfill yields to the event loop (the server must stay responsive)', async () => {
  const t = await setup();
  const content = 'z'.repeat(400);
  const lines = Array.from({ length: 25000 }, (_, i) => line({ id: `bulk-${i}`, content }));
  write(t.main, lines); // about 12 MB
  let worst = 0; let last = Date.now();
  const timer = setInterval(() => { const now = Date.now(); worst = Math.max(worst, now - last); last = now; }, 5);
  const r = await t.ix.scan();
  clearInterval(timer);
  assert.equal(r.newMessages, 25000);
  assert.ok(worst < 400, `the event loop was blocked for ${worst} ms during the scan`);
  t.ix.close();
});

test('prices(): seeded on first open, edits persist across a reopen', async () => {
  const { SEED_PRICES } = await P();
  const t = await setup();
  const rows = t.ix.prices();
  assert.equal(rows.length, SEED_PRICES.length);
  assert.ok(rows.some((r) => r.model === 'claude-opus-5'));
  const edited = rows.map((r) => (r.model === 'claude-opus-5' ? { ...r, input: 99 } : r));
  t.ix.setPrices(edited);
  t.ix.close();
  const again = await t.open();
  assert.equal(again.prices().find((r) => r.model === 'claude-opus-5').input, 99);
  assert.equal(again.prices().length, SEED_PRICES.length);
  again.close();
});

// ---------------- src/prices.js ----------------
const FIELDS = ['input', 'output', 'cacheWrite', 'cacheWrite1h', 'cacheRead'];
const zero = { input: 0, output: 0, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 0 };
const M = 1e6;
const rate = async (model, field) => { const { SEED_PRICES, priceFor, costOf } = await P(); const p = priceFor(SEED_PRICES, model); assert.ok(p, `no price for ${model}`); return costOf({ ...zero, [field]: M }, p); };

test('prices: the seed table matches the claude-api skill numbers (per million tokens)', async () => {
  // model prefix: [input, output, cache write 5m, cache write 1h, cache read]
  const want = {
    'claude-fable-5-1': [10, 50, 12.5, 20, 0.25], 'claude-fable-5': [10, 50, 12.5, 20, 1],
    'claude-opus-5-5': [4, 20, 5, 8, 0.2], 'claude-opus-5': [5, 25, 6.25, 10, 0.5],
    'claude-opus-4-8': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-7': [5, 25, 6.25, 10, 0.5], 'claude-opus-4-6': [5, 25, 6.25, 10, 0.5],
    'claude-sonnet-5-5': [2, 10, 2.5, 4, 0.2], 'claude-sonnet-5': [2, 10, 2.5, 4, 0.2], 'claude-sonnet-4-6': [3, 15, 3.75, 6, 0.3],
    'claude-haiku-5-5': [0.1, 0.5, 0.125, 0.2, 0.01], 'claude-haiku-4-5': [1, 5, 1.25, 2, 0.1],
  };
  for (const [model, rates] of Object.entries(want)) {
    // cacheWrite counts ALL cache writes; costOf prices (cacheWrite - cacheWrite1h) at the 5m rate and cacheWrite1h at the 1h rate.
    const got = [await rate(`${model}-20261001`, 'input'), await rate(`${model}-20261001`, 'output'), await rate(`${model}-20261001`, 'cacheWrite'), null, await rate(`${model}-20261001`, 'cacheRead')];
    const { SEED_PRICES, priceFor, costOf } = await P();
    got[3] = costOf({ ...zero, cacheWrite: M, cacheWrite1h: M }, priceFor(SEED_PRICES, `${model}-20261001`));
    rates.forEach((r, i) => assert.ok(Math.abs(got[i] - r) < 1e-9, `${model}[${i}] expected ${r}, got ${got[i]}`));
  }
});

test('prices: priceFor picks the longest id prefix and returns null for unknown models', async () => {
  const { SEED_PRICES, priceFor, costOf } = await P();
  const out = (m) => { const p = priceFor(SEED_PRICES, m); return p && costOf({ ...zero, cacheRead: M }, p); };
  assert.equal(out('claude-fable-5-1-20261001'), 0.25, 'fable-5-1 is longer than fable-5');
  assert.equal(out('claude-fable-5-0'), 1);
  assert.equal(out('claude-opus-5-5-20261001'), 0.2, 'opus-5-5 beats opus-5');
  assert.equal(out('claude-opus-5-1-20261001'), 0.5);
  assert.equal(out('claude-sonnet-5-5-x'), 0.2);
  assert.ok(Math.abs(out('claude-haiku-5-5-x') - 0.01) < 1e-12);
  assert.equal(priceFor(SEED_PRICES, 'gpt-4o'), null);
  assert.equal(priceFor(SEED_PRICES, ''), null);
  assert.equal(priceFor(SEED_PRICES, '<synthetic>'), null);
  assert.equal(priceFor([], 'claude-opus-5'), null);
});

test('prices: costOf = (input*in + output*out + (cacheWrite-cacheWrite1h)*cw + cacheWrite1h*cw1h + cacheRead*read) / 1e6', async () => {
  const { SEED_PRICES, priceFor, costOf } = await P();
  const p = priceFor(SEED_PRICES, 'claude-sonnet-5-5-20261001');
  const row = { input: 1_000_000, output: 500_000, cacheWrite: 2_000_000, cacheWrite1h: 1_000_000, cacheRead: 4_000_000 };
  // 1*2 + 0.5*10 + 1*2.5 (5m part) + 1*4 (1h part) + 4*0.2
  assert.ok(Math.abs(costOf(row, p) - (2 + 5 + 2.5 + 4 + 0.8)) < 1e-9);
  assert.equal(costOf(zero, p), 0);
  assert.ok(Math.abs(costOf({ ...zero, input: 1 }, p) - 2e-6) < 1e-15);
  for (const f of FIELDS) assert.ok(await rate('claude-opus-5-20261001', f) >= 0, f);
});
