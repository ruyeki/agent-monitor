// Holdout (phase B, AC10 in the server): the indexer runs inside startServer. Fresh data shows within 10 s;
// a big backfill neither delays listen() nor makes the server unresponsive (hooks have a 1 s client timeout).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { boot, req, tmp, until, sleep, tline, writeLines, appendLines, mainFile, hook } from './holdout-v2-helpers.js';

const usage = (S) => req(S.port, 'GET', '/api/stats/usage');

test('AC10 server: usage.db is created in dataDir and a transcript written after boot is visible within 10 s, appends too', async () => {
  const projects = tmp('am-proj-');
  const S = await boot({ projects });
  try {
    assert.ok(fs.existsSync(path.join(S.home, 'usage.db')));
    assert.equal((await usage(S)).json.indexer.messages, 0);
    const f = mainFile(projects, 'sess-fresh');
    const t0 = Date.now();
    writeLines(f, [tline({ id: 'f1', ts: Date.now(), session: 'sess-fresh', input: 11, output: 1 })]);
    const first = await until(async () => (await usage(S)).json.indexer.messages === 1, 10000, 100);
    assert.ok(first, 'a new transcript was not indexed within 10 s');
    assert.ok(Date.now() - t0 < 10500);
    appendLines(f, [tline({ id: 'f2', ts: Date.now(), session: 'sess-fresh', input: 22, output: 2 })]);
    const second = await until(async () => (await usage(S)).json.indexer.messages === 2, 10000, 100);
    assert.ok(second, 'an appended message was not indexed within 10 s');
    const r = (await usage(S)).json;
    assert.equal(r.periods.today.input, 33);
    assert.equal(typeof r.indexer.lastScanAt, 'string');
  } finally { await S.srv.close(); }
});

test('AC10 server: a restart on the same data dir keeps the index and re-reads nothing twice', async () => {
  const projects = tmp('am-proj-');
  const home = tmp('am-home-');
  writeLines(mainFile(projects, 'sess-r'), [tline({ id: 'r1', ts: Date.now(), session: 'sess-r', input: 5, output: 1 })]);
  const a = await boot({ projects, home });
  try { assert.ok(await until(async () => (await usage(a)).json.indexer.messages === 1, 10000, 100)); } finally { await a.srv.close(); }
  const b = await boot({ projects, home });
  try {
    await sleep(1500);
    const r = (await usage(b)).json;
    assert.equal(r.indexer.messages, 1, 'still one message, not two');
    assert.equal(r.periods.today.input, 5);
  } finally { await b.srv.close(); }
});

test('AC10 server: a 40 MB backfill (with one 3 MB line) does not delay listen() and the server stays responsive during the scan', async () => {
  const projects = tmp('am-proj-');
  const now = Date.now();
  let total = 0;
  for (const proj of ['pa', 'pb', 'pc']) {
    const lines = [];
    for (let i = 0; i < 38000; i++) lines.push(tline({ id: `${proj}-${i}`, ts: now - 60000, session: `s-${proj}`, input: 3, output: 1, cacheRead: 7 }));
    total += lines.length;
    writeLines(mainFile(projects, `s-${proj}`, proj), lines);
  }
  const huge = JSON.parse(tline({ id: 'huge-1', ts: now - 60000, session: 's-pa', input: 4, output: 1 }));
  huge.message.content[0].text = 'y'.repeat(3 * 1024 * 1024);
  fs.appendFileSync(mainFile(projects, 's-pa', 'pa'), JSON.stringify(huge) + '\n');
  total += 1;

  const t0 = Date.now();
  const S = await boot({ projects });
  const bootMs = Date.now() - t0;
  try {
    assert.ok(bootMs < 3000, `listen() was delayed by the backfill: ${bootMs} ms`);
    const lat = [];
    let samples = 0; let seenPartial = false;
    const deadline = Date.now() + 90000;
    while (Date.now() < deadline) {
      const a = Date.now();
      const r = await (samples % 2 ? hook(S.port, { hook_event_name: 'Stop', session_id: 'x', transcript_path: '/nope.jsonl' }) : req(S.port, 'GET', '/api/runs'));
      lat.push(Date.now() - a);
      assert.equal(r.status, 200);
      samples++;
      const st = (await usage(S)).json.indexer;
      if (st.messages < total) seenPartial = true;
      if (st.messages === total) break;
      await sleep(15);
    }
    const max = Math.max(...lat);
    assert.ok(seenPartial, 'the scan finished before it could be observed: fixture too small for this machine');
    assert.ok(samples >= 5, `only ${samples} requests were answered during the scan`);
    assert.ok(max < 600, `the slowest of ${samples} requests during the scan took ${max} ms`);
    const final = (await usage(S)).json.indexer;
    assert.equal(final.messages, total, 'every message including the one in the 3 MB line was indexed');
  } finally { await S.srv.close(); }
});

test('AC10 server: close() stops the scanner; later transcript writes are not picked up by a closed server', async () => {
  const projects = tmp('am-proj-');
  const home = tmp('am-home-');
  const S = await boot({ projects, home });
  await S.srv.close();
  writeLines(mainFile(projects, 'sess-late'), [tline({ id: 'late1', ts: Date.now(), session: 'sess-late' })]);
  await sleep(6500);
  // a fresh open on the same data dir must work (the db is not locked by a leaked handle) and then see the message
  const T = await boot({ projects, home });
  try { assert.ok(await until(async () => (await usage(T)).json.indexer.messages === 1, 10000, 100), 'reopened db does not index'); } finally { await T.srv.close(); }
});
