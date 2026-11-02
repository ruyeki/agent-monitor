import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openUsage, LIMIT_FRESH_MS } from '../src/usage.js';
import { usageStats, localDay } from '../src/stats.js';
import { tmp, until } from './codex-helpers.js';

const TEMPLATE = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'limit-line.jsonl'), 'utf8');
const hitLine = ({ session = 's1', agent = null, ts = new Date().toISOString(), error } = {}) => {
  let l = TEMPLATE.replace('__SESSION__', session).replace('__TS__', ts);
  l = agent ? l.replace('__AGENT__', agent) : l.replace('"agentId":"__AGENT__",', '');
  return error ? l.replace('"rate_limit"', JSON.stringify(error)) : l;
};

async function setup(t) {
  const projectsDir = tmp('am-proj-');
  const usage = await openUsage({ dataDir: tmp(), projectsDir });
  t.after(() => usage.close());
  const hits = [];
  const put = (rel, text) => { const f = path.join(projectsDir, ...rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, text); };
  // One scan through start(), the way the server runs it, then stop the timer.
  const scan = async () => {
    const before = usage.status().lastScanAt;
    usage.start({ intervalMs: 600000, onLimit: (h) => hits.push(h) });
    await until(() => usage.status().lastScanAt !== before && !usage.status().scanning);
    await new Promise((r) => setTimeout(r, 50));
    usage.stop();
  };
  return { usage, hits, put, scan };
}

test('a fresh rate_limit entry in a main transcript is reported once, with session and reset time, and is not a usage message', async (t) => {
  const s = await setup(t);
  s.put(['-p', 's1.jsonl'], hitLine({ session: 's1' }));
  await s.scan();
  assert.equal(s.hits.length, 1);
  assert.equal(s.hits[0].sessionId, 's1');
  assert.equal(s.hits[0].agentId, null);
  assert.equal(s.hits[0].resetsAt, new Date(1791655200 * 1000).toISOString());
  assert.equal(s.usage.messages().length, 0);
});

test('a subagent transcript hit carries the agent id', async (t) => {
  const s = await setup(t);
  s.put(['-p', 's1', 'subagents', 'agent-x.jsonl'], hitLine({ session: 's1', agent: 'agent-x' }));
  await s.scan();
  assert.deepEqual(s.hits.map((h) => [h.sessionId, h.agentId]), [['s1', 'agent-x']]);
});

test('old hits, other API errors and malformed lines never fire', async (t) => {
  const s = await setup(t);
  const old = new Date(Date.now() - LIMIT_FRESH_MS - 60000).toISOString();
  s.put(['-p', 's1.jsonl'], hitLine({ ts: old }) + hitLine({ error: 'authentication_failed' }) + hitLine({ error: 'overloaded' }) + '{"isApiErrorMessage":true, broken\n');
  await s.scan();
  assert.equal(s.hits.length, 0);
});

test('a hit appended later is seen by the next scan, once', async (t) => {
  const s = await setup(t);
  await s.scan();
  s.put(['-p', 's2.jsonl'], hitLine({ session: 's2' }));
  await s.scan();
  await s.scan();
  assert.equal(s.hits.length, 1);
});

test('codex turns are stored as provider codex, split cached input, and stay out of Claude attribution', async (t) => {
  const s = await setup(t);
  const at = new Date();
  s.usage.addCodexTurn({ runId: 'r1', threadId: 'thr-1', model: 'gpt-5.6-sol', usage: { input_tokens: 1000, cached_input_tokens: 400, output_tokens: 50 }, at });
  s.usage.addCodexTurn({ runId: 'r1', threadId: 'thr-1', model: 'gpt-5.6-sol', usage: { input_tokens: 10, cached_input_tokens: 50, output_tokens: 5 }, at });
  assert.deepEqual(s.usage.codexTotals('r1'), [{ model: 'gpt-5.6-sol', input: 600, output: 55, cacheWrite: 0, cacheWrite1h: 0, cacheRead: 450 }]);
  assert.deepEqual(s.usage.codexTotals('other'), []);
  assert.equal(s.usage.messages().length, 0);
  assert.equal(s.usage.totals({ sessionIds: ['thr-1'] }).length, 0);
  assert.deepEqual(s.usage.daily().map((r) => [r.provider, r.model, r.input]), [['codex', 'gpt-5.6-sol', 600]]);
});

test('usage stats: Claude periods are unchanged by Codex rows; Codex has its own periods and daily rows say provider', async (t) => {
  const s = await setup(t);
  const now = new Date();
  s.put(['-p', 's1.jsonl'], `${JSON.stringify({ type: 'assistant', sessionId: 's1', timestamp: now.toISOString(),
    message: { id: 'm1', model: 'claude-opus-5', usage: { input_tokens: 10, output_tokens: 5 } } })}\n`);
  await s.usage.scan();
  const before = usageStats({ usage: s.usage, prices: s.usage.prices(), now });
  s.usage.addCodexTurn({ runId: 'r1', threadId: 'thr-1', model: 'gpt-5.6-sol', usage: { input_tokens: 100, output_tokens: 20 }, at: now });
  const after = usageStats({ usage: s.usage, prices: s.usage.prices(), now });
  assert.deepEqual(after.periods, before.periods);
  assert.deepEqual(after.unpricedModels, before.unpricedModels);
  for (const p of ['today', 'week', 'month']) {
    assert.equal(after.codex[p].total, 120, p);
    assert.equal(after.codex[p].cost, 0);
  }
  assert.equal(before.codex.today.total, 0);
  assert.deepEqual(after.daily.map((r) => r.provider).sort(), ['claude', 'codex']);
  assert.equal(after.daily[0].day, localDay(now));
});

test('usage.db user_version 1 -> 2 adds the provider column and keeps old rows as claude', async (t) => {
  const dataDir = tmp();
  const raw = new DatabaseSync(path.join(dataDir, 'usage.db'));
  raw.exec(`CREATE TABLE usage_files (path TEXT PRIMARY KEY, size INTEGER NOT NULL, offset INTEGER NOT NULL, mtime_ms REAL NOT NULL);
    CREATE TABLE usage_messages (id TEXT PRIMARY KEY, ts TEXT NOT NULL, day TEXT NOT NULL, session_id TEXT, agent_id TEXT, project TEXT, model TEXT,
      input INTEGER NOT NULL DEFAULT 0, output INTEGER NOT NULL DEFAULT 0, cache_write INTEGER NOT NULL DEFAULT 0,
      cache_write_1h INTEGER NOT NULL DEFAULT 0, cache_read INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE prices (model TEXT PRIMARY KEY, input REAL NOT NULL, output REAL NOT NULL, cache_write REAL NOT NULL,
      cache_write_1h REAL NOT NULL, cache_read REAL NOT NULL, note TEXT NOT NULL DEFAULT '');
    INSERT INTO usage_messages (id, ts, day, session_id, model, input, output) VALUES ('old', '2026-10-01T00:00:00.000Z', '2026-10-01', 's', 'claude-opus-5', 3, 4);
    PRAGMA user_version = 1;`);
  raw.close();
  const usage = await openUsage({ dataDir, projectsDir: tmp('am-proj-') });
  t.after(() => usage.close());
  assert.deepEqual(usage.messages().map((m) => m.id), ['old']);
  assert.equal(usage.daily()[0].provider, 'claude');
  usage.addCodexTurn({ runId: 'r', threadId: 't', model: 'm', usage: { input_tokens: 1, output_tokens: 1 } });
  assert.equal(usage.codexTotals('r').length, 1);
  const check = new DatabaseSync(path.join(dataDir, 'usage.db'));
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, 2);
  check.close();
});
