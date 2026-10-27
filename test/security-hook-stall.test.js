// EXPLOIT: GET /api/stats/versions (also /api/workflow/versions and /api/runs/:id) re-attributes runs
// synchronously from usage.db on every call. On a long session the event loop stalls for seconds. Hooks
// are installed as `curl ... -m 1 || true`, so any hook that waits more than 1 s fails OPEN: the
// stopped-run deny and the subagent `respond` deny are silently skipped. These GETs pass the Host/Origin
// guard without an Origin header, which is what a cross-site no-cors GET sends; the UI also refetches
// them on every SSE 'usage' event.
// Own temp server only (port 0, temp dirs). Secure behaviour asserted: the deny for a stopped run's
// subagent comes back within the 1 s hook budget while a stats request is running.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { REPO, load } from './holdout-helpers.js';
const { startServer } = await load('src/server.js');
const N = 100000;

test('stopped-run deny arrives within the 1 s hook budget during a stats request', { timeout: 120000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wh-stall-'));
  const dataDir = path.join(root, 'data');
  const projectsDir = path.join(root, 'projects');
  fs.mkdirSync(path.join(projectsDir, 'p'), { recursive: true });
  const t0 = Date.now() - N * 1000;
  const out = fs.createWriteStream(path.join(projectsDir, 'p', 'S.jsonl'));
  for (let i = 0; i < N; i++) {
    out.write(`${JSON.stringify({ type: 'assistant', sessionId: 'S', agentId: i % 2 ? `ag${i % 7}` : undefined, timestamp: new Date(t0 + i * 1000).toISOString(),
      message: { id: `msg_${i}`, model: 'claude-sonnet-5', usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 } } })}\n`);
  }
  await new Promise((r) => out.end(r));
  const srv = await startServer({ port: 0, dataDir, projectsDir, webDir: root, usageIntervalMs: 3600000 });
  try {
    await srv.usage.scan();
    const { store } = srv;
    // a finished run that owns the long main session
    const { run: done } = store.startRun({ title: 'old' });
    store.createAgent({ id: 'main:S', runId: done.id, sessionId: 'S', type: 'main' });
    for (let i = 0; i < 7; i++) store.createAgent({ id: `ag${i}`, runId: done.id, sessionId: 'S', type: 'worker' });
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(path.join(dataDir, 'agent-monitor.db'));
    db.prepare('UPDATE runs SET created_at = ? WHERE id = ?').run(new Date(t0 - 1000).toISOString(), done.id);
    db.close();
    for (let i = 0; i < 40 && store.getRun(done.id).status !== 'done'; i++) {
      const r = store.getRun(done.id);
      const s = store.summary(r);
      if (r.status === 'waiting') store.respond(done.id, { action: s.actions[0].label });
      else store.completeStage(done.id, { stage: s.active[0].id, outcome: 'pass' });
    }
    // a live run Ryan stopped, with a subagent still working
    const { run: live } = store.startRun({ title: 'live' });
    store.createAgent({ id: 'evil', runId: live.id, sessionId: 'T', type: 'worker' });
    store.stopRun(live.id);

    const base = `http://127.0.0.1:${srv.port}`;
    const hookBody = JSON.stringify({ hook_event_name: 'PreToolUse', session_id: 'T', agent_id: 'evil', tool_name: 'Bash', tool_input: { command: 'git push' } });
    const stats = fetch(`${base}/api/stats/versions`).then((r) => r.text()); // no Origin header
    await new Promise((r) => setImmediate(r));
    const h0 = performance.now();
    const ctl = AbortSignal.timeout(1000); // the installed hook's curl -m 1
    let decision = null;
    try {
      const res = await fetch(`${base}/hook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: hookBody, signal: ctl });
      decision = (await res.json()).hookSpecificOutput?.permissionDecision ?? null;
    } catch { /* timed out: the hook command prints nothing and Claude Code allows the call */ }
    const ms = performance.now() - h0;
    await stats;
    assert.equal(decision, 'deny', `hook gave no deny within 1 s (waited ${ms.toFixed(0)} ms): the stopped run's subagent runs 'git push'`);
  } finally {
    await srv.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
