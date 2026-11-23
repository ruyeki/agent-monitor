// White-hat probes: hook- and agent-supplied text (tool names, summaries, error text, agent types, run titles, ask text,
// action labels) reaching the vendored affectUI pieces must render as text, never as markup, URLs or attributes that run.
// Copy into web/test/ and run `npx vitest run test/vendored-xss.exploit.test.jsx`.
import { fireEvent, render, screen, act } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunSide } from '../src/run/RunSide.jsx';
import { Monitor } from '../src/Monitor.jsx';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0, cost: 0 };
const PAYLOADS = [
  '<img src=x onerror="window.__pwn=1">',
  '"><svg onload="window.__pwn=2">',
  'javascript:window.__pwn=3',
  '</code><script>window.__pwn=4</script>',
  '{{constructor.constructor("window.__pwn=5")()}}',
];

function assertInert(container) {
  expect(window.__pwn).toBeUndefined();
  expect(container.querySelector('img, script, iframe, object, embed, svg[onload], [onerror], [onload]')).toBeNull();
  for (const el of container.querySelectorAll('*')) {
    for (const a of el.attributes) {
      expect(a.name.startsWith('on'), `event-handler attribute ${a.name} on ${el.tagName}`).toBe(false);
      if (a.name === 'href' || a.name === 'src' || a.name === 'action' || a.name === 'formaction') {
        expect(/^\s*javascript:/i.test(a.value), `${a.name}=${a.value}`).toBe(false);
      }
    }
  }
}

beforeEach(() => {
  delete window.__pwn;
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
  vi.setSystemTime(NOW);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('RunSide: tool call cards and the working pill with hostile hook text', () => {
  it('renders every payload as text in name, summary, agent label, error text and pill label', () => {
    let id = 1;
    const activity = [];
    for (const p of PAYLOADS) {
      activity.push({ id: id++, at: iso(NOW - 60000), agentId: p, event: 'tool', tool: p, summary: p, toolUseId: `t${id}`, endedAt: iso(NOW - 59000), outcome: 'error' });
      activity.push({ id: id++, at: iso(NOW - 59000), agentId: p, event: 'error', tool: p, summary: p, toolUseId: `t${id - 1}` });
    }
    activity.push({ id: id++, at: iso(NOW - 1000), agentId: 'a1', event: 'tool', tool: PAYLOADS[0], summary: PAYLOADS[1], toolUseId: 'live', endedAt: null, outcome: null });
    activity.reverse();
    const detail = {
      run: { id: 'r', title: PAYLOADS[2], stage: 'build', stageName: PAYLOADS[3], round: 1, maxRounds: 5, status: 'active', actions: [], active: [{ id: 'build', name: PAYLOADS[3] }] },
      agents: [
        { id: 'a1', type: PAYLOADS[4], status: 'running', lastActivityAt: iso(NOW - 1000), model: PAYLOADS[0], description: PAYLOADS[1], lastTool: PAYLOADS[0], lastSummary: PAYLOADS[1] },
        ...PAYLOADS.map((p) => ({ id: p, type: p, status: 'finished', lastActivityAt: iso(NOW - 60000) })),
      ],
      activity,
      timeline: [],
      tokens: { total: tk, main: tk, unattributed: tk, nodes: tk },
      durationMs: 1000,
    };
    const { container } = render(<RunSide detail={detail} onChanged={() => {}} />);
    // open every card so the error text and the body are in the DOM, and let the live timer tick
    for (const b of container.querySelectorAll('.ui-tclc__head')) fireEvent.click(b);
    act(() => { vi.advanceTimersByTime(1000); });
    assertInert(container);
    expect(container.textContent).toContain(PAYLOADS[0]);
    expect(container.querySelector('.ui-tlc')).not.toBeNull();
  });
});

describe('Monitor decision inbox with hostile run titles, ask text and action labels', () => {
  it('renders title, ask, label tooltip, reply label and buttons as text; Open run is a hash link', () => {
    const waiting = PAYLOADS.map((p, i) => ({
      id: `run-${i}`, title: p, stage: 'gate', stageName: p, round: 1, maxRounds: 3, status: 'waiting',
      updatedAt: iso(NOW - (10 - i) * 1000), ask: `## ${p}\n\n**What:** ${p} \`${p}\``, textField: true,
      actions: [{ label: p }, { label: 'Reject' }],
    }));
    const { container } = render(
      <Monitor groups={{ waiting, active: [], finished: [] }} query="" view="" loadError={null} updatedAt={null} tick={0} onDone={() => {}} />,
    );
    assertInert(container);
    for (const a of container.querySelectorAll('a')) expect(a.getAttribute('href')).toMatch(/^#\/runs\//);
    expect(screen.getAllByRole('button', { name: PAYLOADS[0] }).length).toBeGreaterThan(0);
  });
});
