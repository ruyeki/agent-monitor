// EXPLOIT (white-hat, am-affect-pro): every PostToolUse response of a tracked run (any tool, change candidate or not)
// goes through redact() whole before the 1000-char cut (hooks.js ledgerText / changeResult, called unconditionally).
// redact's URL pattern `\b([a-z][a-z0-9+.-]*:\/\/...` rescans to the end of a dotted run from every letter: quadratic.
// A response holding `a.a.a...` (a file an agent edits or writes: Claude Code puts its text in tool_response; command
// output; an MCP document) blocks the event loop: every hook times out (curl -m 1, fail open, so the stop / self-API
// denies are gone), MCP and the UI freeze. A long candidate command (PreToolUse) does the same through the input path.
// Secure behaviour asserted: redact is linear, and the server answers a hook within the 1 s client timeout.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer } from '../src/server.js';
import { redact } from '../src/ledger.js';
import { req, tmp, sleep } from './holdout-helpers.js';

const dotted = (kb) => 'a.'.repeat(kb * 512);

test('redact is linear on a long dotted run (100 KB under 250 ms)', () => {
  redact(dotted(1)); // warm up
  const t0 = performance.now();
  redact(dotted(100));
  const ms = Math.round(performance.now() - t0);
  assert.ok(ms < 250, `redact took ${ms} ms on 100 KB`);
});

async function victim(t) {
  const srv = await startServer({ port: 0, dataDir: tmp(), projectsDir: tmp('am-proj-'), webDir: path.join(tmp('am-web-'), 'nope'), usageIntervalMs: 60_000 });
  t.after(() => srv.close());
  const run = srv.store.startRun({ title: 'Victim' }).run.id;
  srv.store.linkSession('s1', run);
  return srv;
}

// Round trip of one hook POST, as the hook's curl sees it.
async function timed(srv, body) {
  const t0 = Date.now();
  const r = await req(srv.port, 'POST', '/hook', { body });
  return { status: r.status, ms: Date.now() - t0 };
}

test('an Edit response with attacker-shaped file text does not stall the server', async (t) => {
  const srv = await victim(t);
  await sleep(50);
  const r = await timed(srv, {
    session_id: 's1', cwd: '/x', hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_use_id: 'tu-edit',
    tool_input: { file_path: '/x/notes.txt', old_string: 'x', new_string: 'y' },
    tool_response: { filePath: '/x/notes.txt', originalFile: dotted(120) }, // a 120 KB file the agent edited
  });
  assert.equal(r.status, 200);
  assert.ok(r.ms < 1000, `the hook took ${r.ms} ms (the hook client gives up after 1 s and fails open)`);
});

test('a long change-candidate command does not stall the server', async (t) => {
  const srv = await victim(t);
  await sleep(50);
  const r = await timed(srv, {
    session_id: 's1', cwd: '/x', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'tu-push',
    tool_input: { command: `git push origin main # ${dotted(120)}` },
  });
  assert.equal(r.status, 200);
  assert.ok(r.ms < 1000, `the hook took ${r.ms} ms (the hook client gives up after 1 s and fails open)`);
});
