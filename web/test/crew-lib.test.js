// Contract C10 (roles and avatars) plus the model label and "who is working" helpers of web/src/lib/crew.js.
import { describe, expect, it } from 'vitest';
import { agentCall, agentLabel, agentLabels, agentName, avatarOf, contextPct, crewTree, modelLabel, nowWorking, roleOf, sortCrew } from '../src/lib/crew.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const ag = (id, type, over = {}) => ({ id, type, description: '', status: 'running', lastActivityAt: iso(NOW - 5000), ...over });

describe('roleOf / avatarOf', () => {
  it('a role named in the type wins over the description; plain types fall through', () => {
    expect(roleOf(ag('a', 'fable-lead', { description: 'Verifier: write tests' }))).toBe('lead');
    expect(roleOf(ag('a', 'white-hat-agent'))).toBe('white-hat');
    expect(roleOf(ag('a', 'code-reviewer'))).toBe('reviewer');
    expect(roleOf(ag('a', 'sonnet-engineer'))).toBe('engineer');
  });
  it('description words win over the type (verifier and white-hat run as sonnet-engineer)', () => {
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Verifier: baseline and holdout tests' }))).toBe('verifier');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'White-hat pass on the diff' }))).toBe('white-hat');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Review the change' }))).toBe('reviewer');
    expect(roleOf(ag('a', 'opus-engineer', { description: 'Lead: steer the build' }))).toBe('lead');
    expect(roleOf(ag('a', 'sonnet-engineer', { description: "Verifier for the lead's plan" }))).toBe('verifier');
    expect(roleOf(ag('a', 'fable-lead', { description: 'Lead: steer the build; review each piece' }))).toBe('lead'); // the first role word wins
    expect(roleOf(ag('a', 'sonnet-engineer', { description: 'Implement the Fleet layout' }))).toBe('engineer');
  });

  it('a specific type wins over description words: the fable-lead is the lead, not a reviewer', () => {
    expect(roleOf(ag('a', 'fable-lead', { description: 'Plans, delegates and reviews the crew-ledger work' }))).toBe('lead');
    expect(avatarOf(ag('a', 'fable-lead', { description: 'Plans, delegates and reviews the crew-ledger work' })).letter).toBe('L');
    expect(roleOf(ag('a', 'code-reviewer', { description: 'Lead the way' }))).toBe('reviewer');
    expect(roleOf(ag('a', 'white-hat', { description: 'Verifier of nothing' }))).toBe('white-hat');
    expect(roleOf(ag('a', 'general-purpose', { description: 'Verifier: baseline tests' }))).toBe('verifier'); // generic type: the description decides
    expect(agentName(ag('a', 'fable-lead', { description: 'Plans, delegates and reviews the work' }))).toBe('fable-lead');
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

describe('agentLabel / agentLabels', () => {
  const crew = [ag('main:s', 'main'), ag('lead', 'fable-lead'), ag('e1', 'sonnet-engineer'), ag('e2', 'sonnet-engineer', { description: 'Build it' }), ag('v', 'sonnet-engineer', { description: 'Verifier: tests' }), ag('e3', 'sonnet-engineer')];
  it('a name shared by several agents gets its number among them, in the run order', () => {
    expect(agentLabel(crew[2], crew)).toBe('sonnet-engineer 1');
    expect(agentLabel(crew[3], crew)).toBe('sonnet-engineer 2');
    expect(agentLabel(crew[5], crew)).toBe('sonnet-engineer 3');
  });
  it('a unique name stays plain, also without a crew', () => {
    expect(agentLabel(crew[1], crew)).toBe('fable-lead');
    expect(agentLabel(crew[4], crew)).toBe('verifier');
    expect(agentLabel(crew[0], crew)).toBe('Main session');
    expect(agentLabel(crew[2])).toBe('sonnet-engineer');
    expect(agentLabel(crew[2], [])).toBe('sonnet-engineer');
  });
  it('agentLabels maps every agent id to its label', () => {
    const m = agentLabels(crew);
    expect([...m.entries()]).toEqual([['main:s', 'Main session'], ['lead', 'fable-lead'], ['e1', 'sonnet-engineer 1'], ['e2', 'sonnet-engineer 2'], ['v', 'verifier'], ['e3', 'sonnet-engineer 3']]);
    expect(agentLabels(null).size).toBe(0);
  });
  it('nowWorking names the working agent by its label', () => {
    const detail = { run: { id: 'r', status: 'active' }, agents: [crew[2], crew[3]], activity: [{ id: 1, at: iso(NOW - 1000), agentId: 'e2', event: 'tool', tool: 'Edit', summary: 'a.js', toolUseId: 'u1', endedAt: null, outcome: null }] };
    expect(nowWorking(detail, NOW)?.name).toBe('sonnet-engineer 2');
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

  it('follows recorded parents: a known parent gives an edge and places the agent under it', () => {
    const t = crewTree([main, lead, eng('e1', 'lead')]);
    expect(t.edges).toEqual([{ from: 'main:s1', to: 'lead' }, { from: 'lead', to: 'e1' }]);
    expect(t.roots.map((n) => n.id)).toEqual(['main:s1']);
    expect(t.unlinked).toEqual([]);
    expect(t.levels.map((l) => l.map((n) => n.id))).toEqual([['main:s1'], ['lead'], ['e1']]);
    expect(at(t, 'e1')).toMatchObject({ parentId: 'lead', edge: 'lead', depth: 2 });
  });

  it('an unknown parent (null, or an agent not in the run) is an unlinked root, not placed under the lead', () => {
    const t = crewTree([main, lead, eng('e1', null), eng('e2', 'gone'), eng('e3', 'lead')]);
    expect(at(t, 'e1')).toMatchObject({ parentId: null, edge: null, depth: 0 });
    expect(at(t, 'e2')).toMatchObject({ parentId: null, edge: null });
    expect(t.unlinked.map((n) => n.id)).toEqual(['e1', 'e2']);
    expect(t.edges.map((e) => e.to).sort()).toEqual(['e3', 'lead']);
    expect(at(t, 'lead').children.map((n) => n.id)).toEqual(['e3']);
  });

  it('an unlinked agent keeps its own linked subtree', () => {
    const t = crewTree([main, eng('e1', null), eng('e2', 'e1')]);
    expect(t.unlinked.map((n) => n.id)).toEqual(['e1']);
    expect(at(t, 'e1').children.map((n) => n.id)).toEqual(['e2']);
    expect(at(t, 'e2')).toMatchObject({ edge: 'e1', depth: 1 });
    expect(t.edges).toEqual([{ from: 'e1', to: 'e2' }]);
  });

  it('a lead with no recorded parent is unlinked too (never guessed under main)', () => {
    const u = crewTree([main, ag('lead', 'fable-lead')]);
    expect(u.roots.map((n) => n.id)).toEqual(['main:s1']);
    expect(u.unlinked.map((n) => n.id)).toEqual(['lead']);
    expect(u.edges).toEqual([]);
  });

  it('several main sessions are all roots; with no main everyone without a parent is unlinked', () => {
    const t = crewTree([main, ag('main:s2', 'main'), eng('e1', 'main:s2')]);
    expect(t.roots.map((n) => n.id)).toEqual(['main:s1', 'main:s2']);
    expect(at(t, 'e1').parentId).toBe('main:s2');
    const alone = crewTree([eng('x', null), eng('y', null)]);
    expect(alone.roots).toEqual([]);
    expect(alone.unlinked.map((n) => n.id)).toEqual(['x', 'y']);
    expect(alone.edges).toEqual([]);
  });

  it('a parent that is the agent itself, or a loop, never makes an edge to itself', () => {
    const self = crewTree([main, lead, eng('e1', 'e1')]);
    expect(at(self, 'e1')).toMatchObject({ parentId: null, edge: null });
    expect(self.unlinked.map((n) => n.id)).toEqual(['e1']);
    const loop = crewTree([eng('a', 'b'), eng('b', 'a')]);
    expect(loop.levels.flat()).toHaveLength(2);
    expect(loop.edges).toHaveLength(1);
    expect(loop.unlinked).toHaveLength(1);
  });

  it('copes with no agents, junk rows and many helpers', () => {
    expect(crewTree(undefined)).toMatchObject({ roots: [], unlinked: [], levels: [], edges: [], nodes: [] });
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
