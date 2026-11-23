// Contract C10 (roles and avatars) plus the model label and "who is working" helpers of web/src/lib/crew.js.
import { describe, expect, it } from 'vitest';
import { agentCall, agentName, avatarOf, contextPct, crewTree, modelLabel, nowWorking, roleOf, sortCrew } from '../src/lib/crew.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ag = (id, type, over = {}) => ({ id, type, description: '', status: 'running', lastActivityAt: iso(NOW - 5000), ...over });

describe('roleOf / avatarOf', () => {
  it('description words win over the type (verifier and white-hat run as sonnet-engineer)', () => {
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Verifier: baseline and holdout tests' }))).toBe('verifier');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'White-hat pass on the diff' }))).toBe('white-hat');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Review the change' }))).toBe('reviewer');
    expect(roleOf(ag('a', 'opus-engineer', { description: 'Lead: steer the build' }))).toBe('lead');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: "Verifier for the lead's plan" }))).toBe('verifier');
    expect(roleOf(ag('a', 'fable-lead', { description: 'Lead: steer the build; review each piece' }))).toBe('lead'); // the first role word wins
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Implement the Fleet layout' }))).toBe('engineer');
  });

  it('falls back to the type: main, fable-lead, *-engineer, worker, codex, anything else', () => {
    expect(roleOf(ag('main:s1', 'main'))).toBe('main');
    expect(roleOf({ id: 'main:s2' })).toBe('main');
    expect(roleOf(ag('a', 'fable-lead'))).toBe('lead');
    expect(roleOf(ag('a', 'haiku-engineer'))).toBe('engineer');
    expect(roleOf(ag('a', 'worker'))).toBe('engineer');
    expect(roleOf(ag('codex:t', 'codex', { provider: 'codex' }))).toBe('codex');
    expect(roleOf(ag('a', 'Explore'))).toBe('other');
    expect(roleOf(null)).toBe('other');
  });

  it('letter and class per role', () => {
    const av = (a) => [avatarOf(a).letter, avatarOf(a).cls];
    expect(av(ag('main:s', 'main'))).toEqual(['M', 'main']);
    expect(av(ag('a', 'fable-lead'))).toEqual(['L', 'lead']);
    expect(av(ag('a', 'sonnet-engineer'))).toEqual(['E', 'eng']);
    expect(av(ag('a', 'sonnet-engineer', { description: 'verifier prep' }))).toEqual(['V', 'ver']);
    expect(av(ag('a', 'sonnet-engineer', { description: 'white-hat' }))).toEqual(['W', 'wh']);
    expect(av(ag('a', 'Explore'))).toEqual(['E', 'other']);
    expect(av(ag('a', ''))).toEqual(['?', 'other']);
  });
});

describe('agentName and sortCrew', () => {
  it('shows the role when the type hides it, else the type; the main session by name', () => {
    expect(agentName(ag('main:s', 'main'))).toBe('Main session');
    expect(agentName(ag('a', 'sonnet-engineer', { description: 'Verifier: tests' }))).toBe('verifier');
    expect(agentName(ag('a', 'sonnet-engineer', { description: 'Build it' }))).toBe('sonnet-engineer');
    expect(agentName(ag('a', 'fable-lead', { description: 'Lead: plan' }))).toBe('fable-lead');
    expect(agentName({ id: 'x' })).toBe('agent');
  });

  it('orders main, lead, engineers, verifier, white-hat, others; ties keep their order', () => {
    const list = [ag('v', 'sonnet-engineer', { description: 'verifier' }), ag('e1', 'sonnet-engineer'), ag('m', 'main'), ag('o', 'Explore'), ag('l', 'fable-lead'), ag('e2', 'opus-engineer')];
    expect(sortCrew(list).map((a) => a.id)).toEqual(['m', 'l', 'e1', 'e2', 'v', 'o']);
    expect(sortCrew(undefined)).toEqual([]);
  });
});

describe('modelLabel', () => {
  it('names the family and version from a model id', () => {
    expect(modelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(modelLabel('claude-sonnet-4-6-20260101')).toBe('Sonnet 4.6');
    expect(modelLabel('claude-sonnet-4-20250514')).toBe('Sonnet 4');
    expect(modelLabel('claude-haiku-4-5')).toBe('Haiku 4.5');
    expect(modelLabel('claude-fable-5')).toBe('Fable 5');
    expect(modelLabel('opus')).toBe('Opus');
    expect(modelLabel('gpt-5.6-sol')).toBe('gpt-5.6-sol');
    expect(modelLabel(null)).toBe('model unknown');
  });
});

describe('agentCall / nowWorking', () => {
  const run = { id: 'r', status: 'active' };
  const tool = (id, agentId, t, summary, agoMs, over = {}) => ({ id, at: iso(NOW - agoMs), agentId, event: 'tool', tool: t, summary, toolUseId: `u${id}`, endedAt: null, outcome: null, ...over });

  it('the newest running call wins: name of its agent and "tool summary"', () => {
    const detail = {
      run,
      agents: [ag('l', 'fable-lead'), ag('e', 'sonnet-engineer')],
      activity: [tool(2, 'e', 'Edit', 'web/src/Monitor.jsx', 1000), tool(1, 'l', 'Read', 'facts.md', 3000)],
    };
    expect(nowWorking(detail, NOW)).toEqual({ agent: detail.agents[1], name: 'sonnet-engineer', call: 'Edit web/src/Monitor.jsx' });
    expect(agentCall(detail, detail.agents[0], NOW)).toBe('Read facts.md');
  });

  it('no running call: the most recently active working agent with its last tool; nobody working gives null', () => {
    const done = { endedAt: iso(NOW - 500), outcome: 'ok' };
    const detail = {
      run,
      agents: [ag('v', 'sonnet-engineer', { description: 'verifier', lastTool: 'Bash', lastSummary: 'npm test', lastActivityAt: iso(NOW - 2000) })],
      activity: [tool(1, 'v', 'Bash', 'npm test', 2000, done)],
    };
    expect(nowWorking(detail, NOW)).toMatchObject({ name: 'verifier', call: 'Bash npm test' });
    expect(nowWorking(detail, NOW + 10 * 60_000)).toBeNull(); // quiet for minutes: not working
    expect(nowWorking({ ...detail, run: { ...run, status: 'done' } }, NOW)).toBeNull();
    expect(nowWorking({}, NOW)).toBeNull();
  });
});

describe('crewTree', () => {
  const main = ag('main:s1', 'main');
  const lead = ag('lead', 'fable-lead', { parentId: 'main:s1' });
  const eng = (id, parentId) => ag(id, 'sonnet-engineer', { description: 'Build', parentId });
  const at = (t, id) => t.nodes.find((n) => n.id === id);

  it('a known parent gives an edge and places the agent under it', () => {
    const t = crewTree([main, lead, eng('e1', 'lead')]);
    expect(t.edges).toEqual([{ from: 'main:s1', to: 'lead' }, { from: 'lead', to: 'e1' }]);
    expect(t.roots.map((n) => n.id)).toEqual(['main:s1']);
    expect(t.levels.map((l) => l.map((n) => n.id))).toEqual([['main:s1'], ['lead'], ['e1']]);
    expect(at(t, 'e1')).toMatchObject({ parentId: 'lead', edge: 'lead', depth: 2 });
  });

  it('an unknown parent (null, or an agent not in the run) goes under the lead with no edge', () => {
    const t = crewTree([main, lead, eng('e1', null), eng('e2', 'gone'), eng('e3', 'lead')]);
    expect(at(t, 'e1')).toMatchObject({ parentId: 'lead', edge: null });
    expect(at(t, 'e2')).toMatchObject({ parentId: 'lead', edge: null });
    expect(t.edges.map((e) => e.to).sort()).toEqual(['e3', 'lead']);
    expect(at(t, 'lead').children.map((n) => n.id)).toEqual(['e3', 'e1', 'e2']); // linked children first
  });

  it('with no lead an unknown parent goes under the main session; the lead itself goes under main without an edge', () => {
    const t = crewTree([main, eng('e1', null)]);
    expect(at(t, 'e1')).toMatchObject({ parentId: 'main:s1', edge: null });
    const u = crewTree([main, ag('lead', 'fable-lead')]);
    expect(at(u, 'lead')).toMatchObject({ parentId: 'main:s1', edge: null });
    expect(u.edges).toEqual([]);
  });

  it('several main sessions are all roots; with no main or lead everyone is a root', () => {
    const t = crewTree([main, ag('main:s2', 'main'), eng('e1', 'main:s2')]);
    expect(t.roots.map((n) => n.id)).toEqual(['main:s1', 'main:s2']);
    expect(at(t, 'e1').parentId).toBe('main:s2');
    const alone = crewTree([eng('x', null), eng('y', null)]);
    expect(alone.roots.map((n) => n.id)).toEqual(['x', 'y']);
    expect(alone.edges).toEqual([]);
  });

  it('a parent that is the agent itself, or a loop, never makes an edge to itself', () => {
    const self = crewTree([main, lead, eng('e1', 'e1')]);
    expect(at(self, 'e1')).toMatchObject({ parentId: 'lead', edge: null });
    const loop = crewTree([eng('a', 'b'), eng('b', 'a')]);
    expect(loop.levels.flat()).toHaveLength(2);
    expect(loop.edges.length).toBeLessThan(2);
  });

  it('copes with no agents, junk rows and many helpers', () => {
    expect(crewTree(undefined)).toMatchObject({ roots: [], levels: [], edges: [], nodes: [] });
    expect(crewTree([null, 3, main]).nodes).toHaveLength(1);
    const many = crewTree([main, lead, ...Array.from({ length: 30 }, (_, i) => eng(`e${i}`, 'lead'))]);
    expect(at(many, 'lead').children).toHaveLength(30);
    expect(many.edges).toHaveLength(31);
  });
});

describe('contextPct', () => {
  it('null when the server has no reading; never a made-up 0', () => {
    expect(contextPct({})).toBeNull();
    expect(contextPct({ context: null })).toBeNull();
    expect(contextPct({ context: { pct: null } })).toBeNull();
    expect(contextPct({ context: { pct: 'x' } })).toBeNull();
  });
  it('a whole percent, also from a string; a real 0 stays 0', () => {
    expect(contextPct({ context: { pct: 38 } })).toBe(38);
    expect(contextPct({ context: { pct: '71' } })).toBe(71);
    expect(contextPct({ context: { pct: 0 } })).toBe(0);
    expect(contextPct({ context: { pct: 140 } })).toBe(100);
  });
});
