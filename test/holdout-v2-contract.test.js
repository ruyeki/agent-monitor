// Holdout (baseline): the MCP tool names are the seven v1 names, with short descriptions.
// The rest of the v1 contract (RUN line, gates, wait, security checks, hooks, SSE) is covered by holdout-api, holdout-mcp, holdout-hooks and server tests.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { boot, mcpClient } from './holdout-v2-helpers.js';

let S; let M;
before(async () => { S = await boot(); M = await mcpClient(S.url); });
after(async () => { try { await M?.client.close(); } catch { /* already closed */ } await S?.srv.close(); });

test('MCP tool names are exactly the seven v1 names', async () => {
  const { tools } = await M.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), ['complete_stage', 'get_run', 'get_workflow', 'list_runs', 'log', 'respond', 'start_run']);
  for (const t of tools) assert.ok(t.description.length <= 200, `${t.name} description is long`);
});
