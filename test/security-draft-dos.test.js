// EXPLOIT (local process only; browsers are stopped by the Origin/Content-Type checks):
// a 2.6 MB draft with 200k nodes is saved, then validating it on every GET /api/workflow and publish
// overflows the stack or burns the CPU, so the workflow API answers 500 until the draft is reset.
// Secure behaviour asserted: the oversized draft is refused (4xx) and the workflow API keeps working.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot } from './holdout-helpers.js';

let S;
before(async () => { S = await boot(); });
after(async () => { await S?.srv.close(); });

test('an oversized workflow draft cannot break GET /api/workflow and publish', async () => {
  const workflow = { nodes: Array.from({ length: 200000 }, (_, i) => ({ id: `n${i}`, type: 'check' })), edges: [], loop: {} };
  const put = await S.api('PUT', '/api/workflow/draft', { body: { workflow } });
  assert.ok(put.status < 500, `PUT draft answered ${put.status}`);
  assert.equal((await S.api('GET', '/api/workflow')).status, 200, 'GET /api/workflow is broken by the saved draft');
  assert.notEqual((await S.api('POST', '/api/workflow/publish')).status, 500, 'publish is broken by the saved draft');
});

test('a draft with as many edges as allowed, in one long chain, still validates quickly', async () => {
  const nodes = Array.from({ length: 100 }, (_, i) => ({ id: `n${i}`, name: 'n', type: i === 99 ? 'end' : 'split' }));
  const edges = Array.from({ length: 300 }, (_, i) => ({ id: `e${i}`, from: `n${i % 99}`, to: `n${(i % 99) + 1}`, on: '*' }));
  const t0 = Date.now();
  const put = await S.api('PUT', '/api/workflow/draft', { body: { workflow: { nodes, edges } } });
  assert.equal(put.status, 200);
  assert.ok(put.json.errors.length > 0);
  assert.equal((await S.api('POST', '/api/workflow/publish')).status, 400);
  assert.ok(Date.now() - t0 < 3000, `took ${Date.now() - t0} ms`);
});
