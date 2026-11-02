// EXPLOIT: the hand-off prompt scans the run note with SPEC_PATH, whose lazy `[^...]*?` re-scans to the end of the
// line from every `X:\` start: quadratic. `log` (any MCP caller: a subagent, Codex, any local process) stores an
// unbounded note. A note of `a:/a:/...` blocks the event loop when the run hands off: every hook times out (fail open,
// so the stop / ownership / self-API denies are gone), MCP and the UI freeze. ~150 KB here = seconds; ~5 MB = about an hour.
// Secure behaviour asserted: the server keeps answering hooks within the 1 s client timeout during the hand-off.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { mcpClient, req } from './holdout-helpers.js';
import { STUB, tmp, sleep, until, makeWorld, calls } from './codex-helpers.js';

test('a crafted run note does not stall the server at hand-off', async (t) => {
  const world = makeWorld();
  const env = { ...process.env, AM_STUB_CALLS: calls([{ lines: [{ type: 'thread.started', thread_id: 'thr-x' }], sleep: 100 }]) };
  const srv = await startServer({
    port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'),
    codex: { command: process.execPath, args: [STUB], root: world.root, env },
  });
  const m = await mcpClient(srv.url);
  t.after(async () => { try { await m.client.close(); } catch { /* closed */ } await srv.close(); });

  const run = srv.store.startRun({ title: 'Victim', repo: world.repo }).run.id;
  srv.store.linkSession('claude-1', run);
  const res = await m.call('log', { run, note: 'a:/'.repeat(50_000) }); // 150 KB through the MCP log tool
  assert.equal(res.isError, false);

  await req(srv.port, 'POST', '/hook', { body: { session_id: 'claude-1', hook_event_name: 'StopFailure', error: 'rate_limit' } });
  await until(() => srv.store.getRun(run).provider === 'codex'); // handed over; the prompt is built next
  // the server runs in this process: a stalled event loop shows as a long gap between two probe iterations
  let worst = 0;
  const end = Date.now() + 6000;
  while (Date.now() < end) {
    const t0 = Date.now();
    await req(srv.port, 'POST', '/hook', { body: { session_id: 'other', hook_event_name: 'Notification', message: 'ping' } });
    await sleep(50);
    worst = Math.max(worst, Date.now() - t0 - 50);
  }
  assert.ok(worst < 1000, `a hook waited ${worst} ms (the Claude/Codex hook client gives up after 1 s and fails open)`);
});
