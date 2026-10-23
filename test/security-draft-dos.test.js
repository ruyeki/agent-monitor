// EXPLOIT (local process only; browsers are stopped by the Origin/Content-Type checks):
// a 2.6 MB draft with 200k stages is saved, then validateWorkflow's Math.max(-1, ...checks)
// overflows the call stack, so GET /api/workflow and publish answer 500 until the draft is reset.
// Secure behaviour asserted: the oversized draft is refused (4xx) or the workflow API keeps working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './holdout-helpers.js';

let S;
before(async () => { S = await boot(); });
after(async () => { await S?.srv.close(); });

test('an oversized workflow draft cannot break GET /api/workflow and publish', async () => {
  const workflow = { stages: Array.from({ length: 200000 }, () => ({ check: {} })), loop: {} };
  const put = await S.api('PUT', '/api/workflow/draft', { body: { workflow } });
  assert.ok(put.status < 500, `PUT draft answered ${put.status}`);
  assert.equal((await S.api('GET', '/api/workflow')).status, 200, 'GET /api/workflow is broken by the saved draft');
  assert.notEqual((await S.api('POST', '/api/workflow/publish')).status, 500, 'publish is broken by the saved draft');
});
