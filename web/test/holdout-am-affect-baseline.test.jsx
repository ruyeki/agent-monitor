// Baseline (#2288): what RunSide and Monitor do today outside the pieces being replaced; must pass before and after.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';
import { RunSide } from '../src/run/RunSide.jsx';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const tk = (n = 0) => ({ input: n, output: 0, cacheWrite: 0, cacheRead: 0, total: n, cost: 0 });
const json = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
const detail = ({ run: ro, ...over } = {}) => ({
  run: { id: 'r', title: 'My run', stage: 'verify', stageName: 'VERIFY', round: 1, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'VERIFY' }], ...(ro ?? {}) },
  workflow: { nodes: [], edges: [] }, timeline: [{ at: iso(NOW - 5000), kind: 'stage', stage: 'plan', round: 0, note: 'hello' }], visits: [], nodes: {}, durationMs: 65000,
  tokens: { nodes: tk(), main: tk(), unattributed: tk(), total: tk(6250) },
  agents: [
    { id: 'a1', type: 'worker', description: 'build it', model: 'sonnet', status: 'running', lastTool: 'Bash', lastSummary: 'npm test', lastActivityAt: iso(NOW - 7000), waitingPermission: false, tokens: tk() },
    { id: 'a2', type: 'lead', model: 'opus', status: 'finished', tokens: tk() },
  ],
  activity: [],
  ...over,
});
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); globalThis.fetch = vi.fn((u) => json(String(u).startsWith('/api/stats/usage') ? { periods: { today: { total: 1500, cost: 0.5 } } } : {})); });
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('RunSide today', () => {
  it('Active agents lists only running agents with type, description, model, idle time and last tool line', () => {
    render(<RunSide detail={detail()} onChanged={() => {}} />);
    const s = document.querySelector('section[aria-label="Active agents"]');
    const lis = s.querySelectorAll('li');
    expect(lis).toHaveLength(1);
    expect(lis[0].textContent).toContain('worker');
    expect(lis[0].textContent).toContain('build it');
    expect(lis[0].textContent).toContain('Sonnet'); // modelLabel, not the raw model id
    expect(lis[0].textContent).not.toMatch(/idle/); // an agent active 7 s ago is not called idle (no-activity text only after a minute)
    expect(lis[0].textContent).toContain('Bash');
    expect(lis[0].textContent).toContain('npm test');
  });

  it('shows "No agent is running." and the waiting-permission badge', () => {
    const { unmount } = render(<RunSide detail={detail({ agents: [] })} onChanged={() => {}} />);
    expect(screen.getByText('No agent is running.')).toBeTruthy();
    unmount();
    render(<RunSide detail={detail({ agents: [{ ...detail().agents[0], waitingPermission: true }] })} onChanged={() => {}} />);
    expect(screen.getByText('waiting for permission')).toBeTruthy();
  });

  it('a waiting run shows the WaitingCard in the run view with every action, and answering posts respond', async () => {
    const onChanged = vi.fn();
    const run = { status: 'waiting', ask: 'Accept the result?', actions: [{ label: 'Accept' }, { label: 'Stop run' }], textField: true };
    render(<RunSide detail={detail({ run })} onChanged={onChanged} />);
    const card = document.querySelector('article[aria-label="Waiting on you: My run"]');
    expect(within(card).getByText('Accept the result?')).toBeTruthy();
    fireEvent.change(within(card).getByLabelText('Reply for My run'), { target: { value: 'ok then' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const call = globalThis.fetch.mock.calls.find(([u]) => u.endsWith('/respond'));
    expect(call[0]).toBe('/api/runs/r/respond');
    expect(JSON.parse(call[1].body)).toEqual({ action: 'Accept', text: 'ok then' });
  });

  it('Status, Totals and Timeline sections are present', () => {
    render(<RunSide detail={detail()} onChanged={() => {}} />);
    expect(screen.getByText(/At: VERIFY/)).toBeTruthy();
    expect(screen.getByText('Duration')).toBeTruthy(); // the shared Totals card
    expect(screen.getByText('hello')).toBeTruthy();
  });
});

describe('Monitor today', () => {
  const run = (id, title, status, over = {}) => ({ id, title, stage: 's', stageName: 'Stage', round: 0, maxRounds: 5, status, updatedAt: iso(NOW - 1000), ...over });
  const mount = (groups, extra = {}) => render(<Monitor groups={groups} query="" view={null} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={() => {}} {...extra} />);

  it('stat strip counts and the usage tiles', async () => {
    mount({ waiting: [run('w', 'W', 'waiting')], active: [run('a', 'A', 'active'), run('b', 'B', 'active')], finished: [run('d', 'D', 'done')] });
    const strip = document.querySelector('section.stat-strip');
    const val = (label) => [...strip.querySelectorAll('.stat')].find((s) => s.querySelector('.stat-label').textContent === label).querySelector('.stat-value').textContent;
    expect(val('Running')).toBe('2');
    expect(val('Needs you')).toBe('1');
    await waitFor(() => expect(val('Tokens today')).not.toBe('–'));
  });

  it('active and finished groups list their runs; search filters them; a finished Codex run shows its tag', () => {
    mount({ waiting: [], active: [run('a', 'Alpha job', 'active')], finished: [run('d', 'Done thing', 'done', { provider: 'codex' })] }, { query: 'alpha' });
    const list = document.querySelector('section[aria-label="Runs"]');
    expect(within(list).getByText('Alpha job')).toBeTruthy();
    expect(within(list).queryByText('Done thing')).toBeNull();
  });

  it('no runs at all: "No runs yet."', () => {
    mount({ waiting: [], active: [], finished: [] });
    expect(screen.getByText('No runs yet.')).toBeTruthy();
  });
});
