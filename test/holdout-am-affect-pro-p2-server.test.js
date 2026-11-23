// Holdout (#2289 piece 2, C6): agent parent link, context fill, v4 -> v5 migration.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openStore } from '../src/store.js';
import { boot, hook, mcpClient, runIdOf, until, tmp, tline, writeLines, mainFile, subFile } from './holdout-v2-helpers.js';

const SID = 's1';
async function world() {
  const S = await boot();
  const mcp = await mcpClient(S.url);
  const id = runIdOf((await mcp.call('start_run', { title: 'Crew run' })).text);
  const tp = mainFile(S.projects, SID);
  fs.mkdirSync(path.dirname(tp), { recursive: true });
  fs.writeFileSync(tp, '');
  const H = (ev, extra = {}) => hook(S.port, { hook_event_name: ev, session_id: SID, transcript_path: tp, cwd: '/x', ...extra });
  await H('PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'x' }, tool_use_id: 'link0', tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame) · round 0/5 · status active` }] } });
  const detail = async () => (await S.api('GET', `/api/runs/${id}`)).json;
  const agent = async (aid) => (await detail()).agents.find((a) => a.id === aid);
  const meta = (aid, obj) => { const f = subFile(S.projects, SID, aid).replace(/\.jsonl$/, '.meta.json'); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(obj)); };
  const touch = (aid) => { const f = subFile(S.projects, SID, aid); fs.mkdirSync(path.dirname(f), { recursive: true }); if (!fs.existsSync(f)) fs.writeFileSync(f, ''); return f; };
  const spawn = async (aid, type = 'sonnet-engineer') => { touch(aid); return H('SubagentStart', { agent_id: aid, agent_type: type }); };
  const call = (tool, tuid, aid) => H('PreToolUse', { tool_name: tool, tool_input: { description: 'd', prompt: 'p' }, tool_use_id: tuid, ...(aid ? { agent_id: aid } : {}) });
  const end = (tool, tuid, aid) => H('PostToolUse', { tool_name: tool, tool_input: {}, tool_response: { ok: true }, tool_use_id: tuid, ...(aid ? { agent_id: aid } : {}) });
  const read = async (aid) => { await H('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls' }, tool_response: {}, tool_use_id: `rd-${aid}-${Math.random()}`, agent_id: aid }); };
  const stop = (aid) => H('SubagentStop', { agent_id: aid, agent_type: 'x', last_assistant_message: 'done', agent_transcript_path: subFile(S.projects, SID, aid) });
  const parentOf = async (aid) => (await agent(aid))?.parentId;
  const close = async () => { await S.srv.close(); };
  return { S, id, H, detail, agent, meta, spawn, call, end, read, stop, parentOf, close, tp };
}
// the main session exists once it makes any call
const mainCall = (w) => w.H('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' }, tool_use_id: 'm0' });
const settle = () => new Promise((r) => setTimeout(r, 400));

test('parent via meta toolUseId: lead -> main, helper -> lead, even when another agent has a pending Agent call', async () => {
  const w = await world();
  try {
    await mainCall(w);
    await w.call('Agent', 'toolu_L'); await w.end('Agent', 'toolu_L');
    w.meta('lead1', { agentType: 'fable-lead', description: 'Lead: x', toolUseId: 'toolu_L' });
    await w.spawn('lead1', 'fable-lead'); await w.read('lead1');
    assert.ok(await until(async () => (await w.parentOf('lead1')) === `main:${SID}`, 5000), 'lead parent should be the main session');
    // main still has an open Agent call, the lead launches the helper: the meta id must win over "who has pending calls"
    await w.call('Agent', 'toolu_open_main');
    await w.call('Task', 'toolu_H', 'lead1'); await w.end('Task', 'toolu_H', 'lead1');
    w.meta('h1', { agentType: 'sonnet-engineer', description: 'Build', toolUseId: 'toolu_H' });
    await w.spawn('h1'); await w.read('h1');
    assert.ok(await until(async () => (await w.parentOf('h1')) === 'lead1', 5000), 'helper parent should be the lead (Task tool also counts)');
    for (const a of (await w.detail()).agents) assert.notEqual(a.parentId, a.id, 'never its own parent');
    assert.equal((await w.agent(`main:${SID}`)).parentId ?? null, null);
  } finally { await w.close(); }
});

test('parent fallback: with no meta id, the one agent with a pending Agent call at SubagentStart is the parent', async () => {
  const w = await world();
  try {
    await mainCall(w);
    await w.call('Agent', 'tu1'); // still pending
    await w.spawn('a1');
    assert.ok(await until(async () => (await w.parentOf('a1')) === `main:${SID}`, 5000), 'pending call of main gives the parent');
  } finally { await w.close(); }
});

test('parent is null (not a guess) when pending Agent calls belong to two agents, when none is pending, for a non-Agent tool id, and for its own call', async () => {
  const w = await world();
  try {
    await mainCall(w);
    await w.spawn('lead1', 'fable-lead'); // nothing pending yet: unknown
    await w.read('lead1');
    await settle();
    assert.equal(await w.parentOf('lead1') ?? null, null, 'no meta and no pending call -> null');
    await w.call('Agent', 'tuA');            // main pending
    await w.call('Agent', 'tuB', 'lead1');   // lead pending
    await w.spawn('h1'); await w.read('h1');
    await settle();
    assert.equal(await w.parentOf('h1') ?? null, null, 'ambiguous pending -> null');
    await w.call('Bash', 'tuBash'); await w.end('Bash', 'tuBash');
    w.meta('h2', { toolUseId: 'tuBash', description: 'x' });
    await w.spawn('h2'); await w.read('h2');
    await settle();
    assert.equal(await w.parentOf('h2') ?? null, null, 'a Bash row is not a parent link');
    await w.call('Agent', 'tuSelf', 'h3'); await w.end('Agent', 'tuSelf', 'h3');
    w.meta('h3', { toolUseId: 'tuSelf', description: 'x' });
    await w.spawn('h3'); await w.read('h3');
    await settle();
    assert.notEqual((await w.parentOf('h3')) ?? null, 'h3', 'never its own parent');
    // positive control: once the older pending calls are over and only the lead has one, a new agent is its child
    await w.end('Agent', 'tuA'); await w.end('Agent', 'tuB', 'lead1');
    await w.call('Agent', 'tuC', 'lead1');
    await w.spawn('ok1');
    assert.ok(await until(async () => (await w.parentOf('ok1')) === 'lead1', 5000), 'a single pending Agent call gives the parent');
  } finally { await w.close(); }
});

test('parent is retried on later token reads when the meta file shows up after the first read', async () => {
  const w = await world();
  try {
    await mainCall(w);
    await w.call('Agent', 'tuX'); await w.end('Agent', 'tuX');
    await w.spawn('late1'); await w.read('late1');
    await settle();
    assert.equal(await w.parentOf('late1') ?? null, null);
    w.meta('late1', { toolUseId: 'tuX', description: 'Late' });
    await w.stop('late1'); // always reads tokens
    assert.ok(await until(async () => (await w.parentOf('late1')) === `main:${SID}`, 5000), 'retry after the meta appears');
  } finally { await w.close(); }
});

test('context fill: latest message by time (not max or sum), window by model, cap 100, unknown model 200k, no message -> null, main agent included', async () => {
  const w = await world();
  try {
    const now = Date.now();
    await mainCall(w);
    for (const a of ['c1', 'c2', 'c3', 'c4']) await w.spawn(a);
    writeLines(subFile(w.S.projects, SID, 'c1'), [
      tline({ id: 'c1a', ts: now - 60000, session: SID, agent: 'c1', model: 'claude-opus-5-5', input: 100, cacheRead: 900000, cacheWrite: 50 }),
      tline({ id: 'c1b', ts: now - 30000, session: SID, agent: 'c1', model: 'claude-opus-5-5', input: 2, cacheRead: 123400, cacheWrite: 54 })]);
    writeLines(subFile(w.S.projects, SID, 'c2'), [tline({ id: 'c2a', ts: now - 30000, session: SID, agent: 'c2', model: 'claude-haiku-4-5-20251001', input: 1000, cacheRead: 299000 })]);
    writeLines(subFile(w.S.projects, SID, 'c3'), [tline({ id: 'c3a', ts: now - 30000, session: SID, agent: 'c3', model: 'mystery-model-9', input: 10000, cacheRead: 40000 })]);
    writeLines(mainFile(w.S.projects, SID), [tline({ id: 'ma', ts: now - 30000, session: SID, model: 'claude-opus-5-5', input: 5, cacheRead: 99995 })]);
    const got = await until(async () => { const d = await w.detail(); return ['c1', 'c2', 'c3', `main:${SID}`].every((i) => d.agents.find((a) => a.id === i)?.context) ? d : null; }, 15000, 250);
    assert.ok(got, 'context for c1 should appear once the indexer has scanned');
    const by = Object.fromEntries(got.agents.map((a) => [a.id, a.context]));
    assert.deepEqual(by.c1, { tokens: 123456, window: 1000000, pct: 12 });
    assert.deepEqual(by.c2, { tokens: 300000, window: 200000, pct: 100 });
    assert.deepEqual(by.c3, { tokens: 50000, window: 200000, pct: 25 });
    assert.equal(by.c4, null, 'no message known: null, never a zero object');
    assert.deepEqual(by[`main:${SID}`], { tokens: 100000, window: 1000000, pct: 10 });
  } finally { await w.close(); }
});

test('migration: a fresh store is user_version 5; a v4 database keeps its rows and old agents get parentId null', () => {
  const dir = tmp('am-pro-v4-');
  const s0 = openStore(dir);
  const rid = s0.startRun({ title: 'Old' }).run.id;
  s0.createAgent({ id: 'old1', runId: rid, sessionId: 's', type: 'worker' });
  s0.updateAgent('old1', { input_tokens: 123, last_tool: 'Bash' });
  s0.close();
  const db = new DatabaseSync(path.join(dir, 'agent-monitor.db'));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 5, 'fresh store at version 5');
  assert.ok(db.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'parent_agent_id'));
  db.exec('ALTER TABLE agents DROP COLUMN parent_agent_id; PRAGMA user_version = 4');
  db.close();
  const s1 = openStore(dir);
  const a = s1.detail(rid).agents.find((x) => x.id === 'old1');
  assert.ok(a, 'agent row kept');
  assert.equal(a.tokens.input, 123);
  assert.ok('parentId' in a, 'parentId key present on migrated rows');
  assert.equal(a.parentId ?? null, null);
  s1.close();
  const chk = new DatabaseSync(path.join(dir, 'agent-monitor.db'), { readOnly: true });
  assert.equal(chk.prepare('PRAGMA user_version').get().user_version, 5);
  assert.ok(chk.prepare('PRAGMA table_info(agents)').all().some((c) => c.name === 'parent_agent_id'));
  assert.equal(chk.prepare('SELECT COUNT(*) n FROM agents').get().n, 1);
  chk.close();
  openStore(dir).close(); // a second open is a no-op
});
