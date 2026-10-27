import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/run/RunView.jsx';
import { sample } from './fixtures.js';

const now = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 404, json: () => Promise.resolve(body) });

const tk = (input, output = 0, cacheWrite = 0, cacheRead = 0, cost = 0) => ({ input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost });

const detail = (over = {}) => ({
  run: {
    id: 'my-run', title: 'My run', stage: 'verify', stageName: 'VERIFY', round: 1, maxRounds: 5, status: 'active', ask: null, actions: [], textField: false,
    active: [{ id: 'verify', name: 'VERIFY', type: 'check' }],
  },
  workflow: sample(),
  timeline: [{ at: iso(now - 5000), kind: 'stage', stage: 'plan', round: 0, note: 'hello' }],
  agents: [
    { id: 'a1', type: 'worker', description: 'build it', model: 'sonnet', status: 'running', lastTool: 'Bash', lastSummary: 'npm test', lastActivityAt: iso(now - 7000), tokens: tk(1000, 200, 10, 40) },
    { id: 'a2', type: 'lead', model: 'opus', status: 'finished', tokens: tk(5000) },
  ],
  activity: [{ at: iso(now - 1000), agentId: 'a1', event: 'tool', tool: 'Bash', summary: 'npm test' }],
  visits: [],
  nodes: { plan: { visits: 2, durationMs: 5000 }, verify: { visits: 1, durationMs: 1000 } },
  durationMs: 65_000,
  tokens: { nodes: tk(6250), main: tk(0), unattributed: tk(0), total: tk(6250) },
  ...over,
});

let fetchMock;
let current;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  current = detail();
  fetchMock = vi.fn((url, opts = {}) => (opts.method === 'POST' ? res({}) : res(current)));
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const nodeEl = (id) => document.querySelector(`[data-node="${id}"]`);

describe('RunView', () => {
  it('draws the pinned graph with the active node highlighted and visit counts on visited ones', async () => {
    render(<RunView id="my-run" />);
    await screen.findByRole('group', { name: 'Run graph' });
    await waitFor(() => expect(nodeEl('verify')).toBeTruthy());
    expect(nodeEl('verify').className).toContain('active');
    expect(nodeEl('plan').className).toContain('visited');
    expect(nodeEl('plan').textContent).toContain('2 visits');
    expect(nodeEl('verify').textContent).toContain('1 visit');
    expect(nodeEl('pr').className).not.toContain('visited');
    expect(nodeEl('pr').className).not.toContain('active');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/runs/my-run');
  });

  it('is read-only: nodes are not draggable and handles cannot start a connection', async () => {
    render(<RunView id="my-run" />);
    await waitFor(() => expect(nodeEl('plan')).toBeTruthy());
    expect(nodeEl('plan').closest('.react-flow__node').className).not.toContain('draggable');
    expect(document.querySelector('.react-flow__handle.connectable')).toBeNull();
  });

  it('shows node tokens when the API has them', async () => {
    current = detail({ nodes: { verify: { visits: 1, durationMs: 1, tokens: { total: 12_345 } } } });
    render(<RunView id="my-run" />);
    await waitFor(() => expect(nodeEl('verify')).toBeTruthy());
    expect(nodeEl('verify').textContent).toContain('12k tokens');
    expect(nodeEl('plan').textContent).not.toContain('tokens');
  });

  it('side panel: running agents only, last activity, totals and timeline', async () => {
    render(<RunView id="my-run" />);
    const agents = within(await screen.findByRole('region', { name: 'Active agents' }));
    expect(agents.getByText('worker')).toBeTruthy();
    expect(agents.getByText('build it')).toBeTruthy();
    expect(agents.getByText(/idle 7s/)).toBeTruthy();
    expect(agents.getByText('npm test')).toBeTruthy();
    expect(agents.queryByText('lead')).toBeNull();
    expect(within(screen.getByRole('region', { name: 'Last activity' })).getByText('npm test')).toBeTruthy();
    const totals = screen.getByRole('region', { name: 'Totals' }).textContent;
    expect(totals).toContain('Tokens: 6.3k'); // the run total from detail.tokens
    expect(totals).toContain('Duration: 1m 5s');
    expect(within(screen.getByRole('region', { name: 'Timeline' })).getByText('hello')).toBeTruthy();
  });

  it('run tokens: total with breakdown, main session shown separately, unattributed only when > 0, estimate label', async () => {
    const t = (input, output, cacheWrite, cacheRead, cost = 0) => ({ input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead, cost });
    current = detail({
      tokens: { nodes: t(1_000_000, 500_000, 0, 0), main: t(100_000, 0, 0, 0), unattributed: t(0, 0, 0, 0), total: t(1_100_000, 1_400_000, 0, 0, 12.5) },
    });
    const { unmount } = render(<RunView id="my-run" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Totals' }).textContent).toContain('2.5M'));
    const totals = screen.getByRole('region', { name: 'Totals' }).textContent;
    expect(totals).toContain('Input 1.1M');
    expect(totals).toContain('Output 1.4M');
    expect(totals).toContain('Main session (not on any stage): 100k');
    expect(totals).not.toContain('Unattributed');
    expect(totals).toContain('≈ $12.50 API-equivalent (estimate)');
    unmount();
    current = detail({ tokens: { nodes: t(1, 0, 0, 0), main: t(0, 0, 0, 0), unattributed: t(3000, 0, 0, 0), total: t(3001, 0, 0, 0) } });
    render(<RunView id="my-run" />);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Totals' }).textContent).toContain('Unattributed: 3.0k'));
  });

  it('waiting run: shows the ask with its action buttons and responds', async () => {
    current = detail({
      run: { ...detail().run, status: 'waiting', stage: 'gate2', ask: 'Accept?', actions: [{ label: 'Accept' }, { label: 'Stop run' }], textField: true, active: [{ id: 'gate2', name: 'GATE2', type: 'gate' }] },
    });
    render(<RunView id="my-run" />);
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'ok' } });
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u]) => u === '/api/runs/my-run/respond')).toBe(true));
    const [, opts] = fetchMock.mock.calls.find(([u]) => u === '/api/runs/my-run/respond');
    expect(JSON.parse(opts.body)).toEqual({ action: 'Accept', text: 'ok' });
  });

  it('Stop asks for confirmation then posts stop', async () => {
    render(<RunView id="my-run" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Stop' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Confirm stop' })).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/runs/my-run/stop' && o?.method === 'POST')).toBe(true));
  });

  it('refetches when the live tick changes and reports an unknown run', async () => {
    const { rerender } = render(<RunView id="my-run" tick={0} />);
    await screen.findByRole('region', { name: 'Totals' });
    const n = fetchMock.mock.calls.length;
    rerender(<RunView id="my-run" tick={1} />);
    await waitFor(() => expect(fetchMock.mock.calls.length).toBe(n + 1));
    fetchMock.mockImplementation(() => res({ error: 'Unknown run.' }, false));
    rerender(<RunView key="other" id="other" tick={1} />);
    expect((await screen.findByRole('alert')).textContent).toMatch(/Could not load run other/);
  });
});
