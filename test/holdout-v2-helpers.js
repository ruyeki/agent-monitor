// Shared helpers for the v2 holdout tests (graph engine, indexer, attribution, stats). Not a test file.
import fs from 'node:fs';
import path from 'node:path';

export * from './holdout-helpers.js';

export const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
export const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
export const clone = (x) => JSON.parse(JSON.stringify(x));

// ---- phase B helpers: fixture transcripts for the usage indexer ----
export const tline = ({ id, ts, session = 'sess-1', agent, model = 'claude-sonnet-5-5-20261001', input = 10, output = 5, cacheWrite = 0, cacheWrite1h = 0, cacheRead = 0 }) => JSON.stringify({
  type: 'assistant', sessionId: session, ...(agent ? { agentId: agent } : {}), timestamp: typeof ts === 'string' ? ts : new Date(ts).toISOString(),
  message: {
    id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }],
    usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
      cache_creation: { ephemeral_5m_input_tokens: cacheWrite - cacheWrite1h, ephemeral_1h_input_tokens: cacheWrite1h } },
  },
});
export const writeLines = (file, lines) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, lines.join('\n') + '\n'); };
export const appendLines = (file, lines) => fs.appendFileSync(file, lines.join('\n') + '\n');
export const mainFile = (projects, session, proj = 'proj') => path.join(projects, proj, `${session}.jsonl`);
export const subFile = (projects, session, aid, proj = 'proj') => path.join(projects, proj, session, 'subagents', `agent-${aid}.jsonl`);
export const localDay = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
export const tokTotal = (r) => r.input + r.output + r.cacheWrite + r.cacheRead;
