// Baseline: behaviour of the touched code on the base commit that must survive the change.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { WaitingCard } from '../src/WaitingCards.jsx';
import { parseRoute } from '../src/lib/route.js';
import { splitRuns } from '../src/lib/format.js';

const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting', verdict: null,
  ask: 'Accept, push and open the PR?', actions: [{ label: 'Accept' }, { label: 'Stop run' }], textField: false, updatedAt: new Date().toISOString(), ...over,
});

describe('baseline lib', () => {
  it('parseRoute', () => {
    expect(parseRoute('#/workflow')).toEqual({ name: 'workflow' });
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
    expect(parseRoute('#/runs/x%2Fy')).toEqual({ name: 'run', id: 'x/y' });
    expect(parseRoute('#/runs/%E0%A4%A')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/nope')).toEqual({ name: 'monitor' });
  });
  it('splitRuns: waiting list, ended runs are finished, order kept', () => {
    const r = splitRuns([{ id: 'a', status: 'active' }, mk('w'), { id: 'd', status: 'done' }, { id: 's', status: 'stopped' }]);
    expect(r.waiting.map((x) => x.id)).toEqual(['w']);
    expect(r.finished.map((x) => x.id)).toEqual(['d', 's']);
    expect(r.live.map((x) => x.id)).toContain('a');
  });
});

describe('baseline card and app', () => {
  let runs;
  beforeEach(() => {
    runs = [mk('w1'), { ...mk('act'), status: 'active', title: 'Busy run' }, { ...mk('fin'), status: 'done', title: 'Done run' }];
    globalThis.EventSource = class { close() {} };
    globalThis.fetch = vi.fn((url, opts = {}) => {
      const j = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
      if (opts.method === 'POST') return j({});
      return url === '/api/runs' ? j(runs) : j({});
    });
    window.location.hash = '#/';
  });
  afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

  it('card shows a one-line ask, its title and posts the chosen action', async () => {
    const onDone = vi.fn();
    render(<WaitingCard run={mk('w1')} onDone={onDone} />);
    expect(screen.getByText('Accept, push and open the PR?')).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w1' })).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Accept' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(globalThis.fetch.mock.calls[0][0]).toBe('/api/runs/w1/respond');
  });
  it('Monitor keeps Runs table, Finished section and the Workflow/Stats tabs', async () => {
    render(<App />);
    await screen.findByText('Busy run');
    expect(screen.getByText('Finished runs (1)')).toBeTruthy();
    const nav = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(nav.getByRole('link', { name: 'Workflow' }).getAttribute('href')).toBe('#/workflow');
    expect(nav.getByRole('link', { name: 'Stats' }).getAttribute('href')).toBe('#/stats');
    expect(nav.getByRole('link', { name: 'Monitor' }).getAttribute('aria-current')).toBe('page');
  });
  it('clicking an active run row opens its run view route', async () => {
    render(<App />);
    fireEvent.click(await screen.findByText('Busy run'));
    expect(window.location.hash).toBe('#/runs/act');
  });
});
