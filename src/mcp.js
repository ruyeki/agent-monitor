// MCP tools at /mcp. A new server and transport per request (stateless).
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { describeStage } from './engine.js';

const BIN = fileURLToPath(new URL('../bin/agent-monitor.js', import.meta.url));

// First line always starts "RUN <id>": the hook parses it to link the session to the run.
export function describeRun(store, runId) {
  const r = store.getRun(runId);
  const s = store.summary(r);
  const lines = [`RUN ${s.id} · stage ${s.stage} (${s.stageName}) · round ${s.round}/${s.maxRounds} · status ${s.status}`];
  if (s.status === 'waiting') {
    lines.push(`WAITING ON RYAN: ${s.ask}`);
    lines.push(`ACTIONS: ${s.actions.map((a) => a.label).join(' | ')}${s.textField ? ' (text allowed)' : ''}`);
    lines.push(`Run in the background: node "${BIN}" wait ${s.id}`);
  } else if (s.status === 'active') {
    const d = describeStage(store.version(s.workflowVersion), s.stage, r);
    lines.push(`NEXT: ${d.id} (${d.name}) — runner ${d.runner}, model ${d.model}`);
    lines.push(`INSTRUCTIONS: ${d.instructions}`);
  }
  return lines.join('\n');
}

const ok = (t) => ({ content: [{ type: 'text', text: t }] });
const fail = (t) => ({ isError: true, content: [{ type: 'text', text: `ERROR: ${t}` }] });
const outcome = (store, res) => (res.error ? fail(res.error) : ok(describeRun(store, res.run.id)));

function workflowText(wf, version) {
  const rows = wf.stages.map((s, i) => `${i + 1}. ${s.id} (${s.name}) — ${s.kind}${s.kind === 'step' ? `, runner ${s.runner}, model ${s.model}` : `, asks "${s.ask}"`}${s.check ? `, check (on fail: ${s.check.onFail})` : ''}${s.pushes ? ', pushes' : ''}`);
  const { loop } = wf;
  return [`WORKFLOW v${version}`, ...rows, `Fix loop: up to ${loop.maxRounds} rounds, then back to ${loop.afterFix}; resume at ${loop.resumeAt} after a decision.`].join('\n');
}

function buildServer(store) {
  const server = new McpServer({ name: 'agent-monitor', version: '1.0.0' });
  const run = z.string().describe('Run id');

  server.registerTool('start_run', {
    description: 'Start a tracked run. Returns the first stage to do.',
    inputSchema: { title: z.string(), slug: z.string().optional(), task: z.string().optional(), repo: z.string().optional(), branch: z.string().optional(), note: z.string().optional() },
  }, async (a) => outcome(store, store.startRun(a)));

  server.registerTool('complete_stage', {
    description: 'Report the outcome of the current stage. Returns the next stage, or says the run waits on Ryan.',
    inputSchema: { run, stage: z.string(), outcome: z.enum(['pass', 'done', 'fail', 'finding', 'regression', 'env', 'stuck']), note: z.string().optional() },
  }, async ({ run: id, ...rest }) => outcome(store, store.completeStage(id, rest)));

  server.registerTool('respond', {
    description: "Answer a gate or decision on Ryan's behalf, only when Ryan told you the answer.",
    inputSchema: { run, action: z.string(), text: z.string().optional() },
  }, async ({ run: id, ...rest }) => outcome(store, store.respond(id, rest)));

  server.registerTool('log', {
    description: 'Add a note to the run timeline.',
    inputSchema: { run, note: z.string() },
  }, async (a) => outcome(store, store.logRun(a.run, a.note)));

  server.registerTool('get_run', { description: 'Show where a run is and what comes next.', inputSchema: { run } },
    async ({ run: id }) => (store.getRun(id) ? ok(describeRun(store, id)) : fail(`No run '${id}'.`)));

  server.registerTool('list_runs', { description: 'List runs, active ones first.', inputSchema: {} }, async () => {
    const all = store.listRuns();
    const open = (r) => (r.status === 'active' || r.status === 'waiting' ? 0 : 1);
    const lines = all.sort((x, y) => open(x) - open(y)).map((r) => `${r.id} · ${r.stage} · ${r.status} · ${r.title}`);
    return ok(lines.join('\n') || 'No runs yet.');
  });

  server.registerTool('get_workflow', {
    description: "Show the workflow: the version a run is pinned to, or the published one.",
    inputSchema: { run: z.string().optional() },
  }, async ({ run: id }) => {
    if (id) {
      const r = store.getRun(id);
      return r ? ok(workflowText(store.version(r.workflow_version), r.workflow_version)) : fail(`No run '${id}'.`);
    }
    const p = store.published();
    return ok(workflowText(p.workflow, p.version));
  });
  return server;
}

export function createMcpHandler(store, allowedHosts) {
  return async (req, res, body) => {
    const server = buildServer(store);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, enableJsonResponse: true, enableDnsRebindingProtection: true, allowedHosts,
    });
    res.on('close', () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  };
}
