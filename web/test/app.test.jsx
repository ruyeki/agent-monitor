import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { Idle } from '../src/Ago.jsx';
import { RunDetail } from '../src/RunDetail.jsx';
import { RunsTable } from '../src/RunsTable.jsx';
import { WaitingCard } from '../src/WaitingCards.jsx';

const now = Date.parse('2026-10-23T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const run = {
  id: 'my-run',
  title: 'My run',
  stage: 'gate1',
  stageName: 'Your solution',
  round: 2,
  maxRounds: 5,
  status: 'waiting',
  verdict: 'pass',
  ask: 'What is your solution?',
  actions: [{ label: 'Agree spec' }, { label: 'Stop run' }],
  textField: true,
  updatedAt: iso(now - 60_000),
};
const json = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });

let fetchMock;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); // fixed clock for the relative times; real timers for everything else
  vi.setSystemTime(now);
  fetchMock = vi.fn(() => json({}));
  globalThis.fetch = fetchMock;
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('WaitingCard', () => {
  it('shows ask and posts the chosen action with the text', async () => {
    const onDone = vi.fn();
    render(<WaitingCard run={run} onDone={onDone} />);
    expect(screen.getByText('What is your solution?')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'use sqlite' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/runs/my-run/respond');
    expect(opts.method).toBe('POST');
    expect(JSON.parse(opts.body)).toEqual({ action: 'Agree spec', text: 'use sqlite' });
  });

  it('disables buttons while posting and shows the inline error', async () => {
    let resolve;
    fetchMock.mockImplementationOnce(() => new Promise((r) => (resolve = r)));
    render(<WaitingCard run={run} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
    expect(screen.getByRole('button', { name: 'Agree spec' }).disabled).toBe(true);
    resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'Run is not waiting.' }) });
    expect((await screen.findByRole('alert')).textContent).toBe('Run is not waiting.');
    expect(screen.getByRole('button', { name: 'Agree spec' }).disabled).toBe(false);
  });
});

describe('RunsTable', () => {
  it('shows rounds n/max, verdict and selects by click and keyboard', () => {
    const onSelect = vi.fn();
    render(<RunsTable runs={[run]} onSelect={onSelect} caption="c" />);
    expect(screen.getByText('2/5')).toBeTruthy();
    expect(screen.getByText('pass')).toBeTruthy();
    expect(screen.getByText('1m ago')).toBeTruthy();
    const row = screen.getByText('My run').closest('tr');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledTimes(2);
  });
});

describe('RunDetail', () => {
  const workflow = {
    loop: { fixRunner: 'worker' },
    stages: [
      { id: 'frame', name: 'Frame', kind: 'step', runner: 'main' },
      { id: 'plan', name: 'Plan', kind: 'step', runner: 'lead' },
      { id: 'build', name: 'Build', kind: 'step', runner: 'worker' },
    ],
  };
  const detail = (over = {}) => ({
    run: { ...run, status: 'active', stage: 'plan' },
    workflow,
    timeline: [{ at: iso(now - 5000), kind: 'stage', stage: 'frame', round: 0, note: 'hello\nworld' }],
    agents: [
      {
        id: 'a1',
        type: 'worker',
        model: 'sonnet',
        status: 'running',
        lastTool: 'Bash',
        lastSummary: 'npm test',
        lastActivityAt: iso(now - 7000),
        toolCalls: 4,
        errors: 1,
        waitingPermission: true,
        tokens: { input: 1200, output: 300, cacheCreation: 10, cacheRead: 40 },
      },
    ],
    activity: [{ at: iso(now - 1000), agentId: 'a1', event: 'tool', tool: 'Bash', summary: 'npm test' }],
    ...over,
  });

  it('map highlights the current stage and marks visited ones', () => {
    const { container } = render(<RunDetail detail={detail()} />);
    expect(container.querySelector('.node.current').getAttribute('data-stage')).toBe('plan');
    expect(container.querySelector('[data-stage="frame"]').className).toContain('visited');
    expect(container.querySelector('[data-stage="build"]').className).not.toContain('visited');
  });

  it('renders agent live fields', () => {
    render(<RunDetail detail={detail()} />);
    expect(screen.getByText('7s')).toBeTruthy();
    expect(screen.getByText('waiting for permission')).toBeTruthy();
    expect(screen.getByText('1.2k / 300 / 50')).toBeTruthy();
  });

  it('stop: cancel does nothing, confirm posts stop', async () => {
    const onChanged = vi.fn();
    render(<RunDetail detail={detail()} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(screen.getByText('Stop run my-run?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    fireEvent.click(within(screen.getByRole('group')).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0][0]).toBe('/api/runs/my-run/stop');
    expect(fetchMock.mock.calls[0][1].method).toBe('POST');
  });

  it('Stop is disabled for ended runs', () => {
    render(<RunDetail detail={detail({ run: { ...run, status: 'done', stage: 'done' } })} />);
    expect(screen.getByRole('button', { name: 'Stop' }).disabled).toBe(true);
  });
});

describe('Idle', () => {
  it('ticks on its own every second', () => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(now);
    render(<Idle since={iso(now - 7000)} />);
    expect(screen.getByText('7s')).toBeTruthy();
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.getByText('9s')).toBeTruthy();
  });
});
