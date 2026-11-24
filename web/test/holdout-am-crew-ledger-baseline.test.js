// Baseline: pure helpers the Crew tab relies on.
import { describe, expect, it } from 'vitest';
import * as crew from '../src/lib/crew.js';
import { toolCalls } from '../src/lib/toolCalls.js';

describe('baseline crew lib', () => {
  it('exports the helpers the tab uses', () => {
    for (const k of ['roleOf', 'agentName', 'sortCrew', 'crewTree', 'contextPct']) expect(typeof crew[k]).toBe('function');
  });
  it('crewTree keeps a known parent link', () => {
    const agents = [{ id: 'm', type: 'main', parentId: null, startedAt: '2026-11-22T10:00:00Z' }, { id: 'l', type: 'fable-lead', parentId: 'm', startedAt: '2026-11-22T10:01:00Z' }];
    const s = JSON.stringify(crew.crewTree(agents));
    expect(s).toContain('"l"');
  });
  it('toolCalls turns a finished tool row into a finished call', () => {
    const rows = [{ id: 1, at: '2026-11-22T12:00:00Z', agentId: 'a', event: 'tool', tool: 'Bash', summary: 'ls', toolUseId: 't', endedAt: '2026-11-22T12:00:01Z', outcome: 'ok' }];
    const out = toolCalls({ activity: rows, agents: [] }, Date.parse('2026-11-22T12:01:00Z'), 10);
    expect(out.length).toBe(1);
    expect(out[0].tool ?? out[0].name).toBe('Bash');
  });
});
