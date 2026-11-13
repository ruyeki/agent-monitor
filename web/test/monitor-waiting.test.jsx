// Monitor page: the waiting cards sit in their own panel above the Runs table; there is no Waiting tab or route.
import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';

const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting', verdict: null,
  ask: 'Accept, push and open the PR?', actions: [{ label: 'Accept' }], textField: false, updatedAt: new Date().toISOString(), ...over,
});

let runs;
const setup = (hash = '#/') => {
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = vi.fn((url) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(url === '/api/runs' ? runs : {}) }));
  window.location.hash = hash;
};

describe('Monitor waiting panel', () => {
  beforeEach(() => {
    runs = [mk('w1'), mk('w2'), { ...mk('act'), status: 'active', title: 'Busy run' }];
    setup();
  });
  afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

  it('shows "Waiting on you (n)" before "Runs (n)", with the cards', async () => {
    render(<App />);
    const waitingH = await screen.findByRole('heading', { name: 'Waiting on you (2)' });
    const runsH = screen.getByRole('heading', { name: 'Runs (1)' });
    expect(waitingH.compareDocumentPosition(runsH) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w1' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w2' })).toBeTruthy();
  });

  it('keeps waiting runs out of the Active runs table', async () => {
    render(<App />);
    await screen.findByText('Busy run');
    const table = within(screen.getByRole('table', { name: 'Active runs' }));
    expect(table.getByText('Busy run')).toBeTruthy();
    expect(table.queryByText('Run w1')).toBeNull();
    expect(table.queryByText('Run w2')).toBeNull();
  });

  it('shows the empty state when nothing waits', async () => {
    runs = [{ ...mk('act'), status: 'active', title: 'Busy run' }];
    render(<App />);
    await screen.findByText('Busy run');
    expect(screen.getByRole('heading', { name: 'Waiting on you (0)' })).toBeTruthy();
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
  });

  it('has no Waiting tab', async () => {
    render(<App />);
    await screen.findByText('Busy run');
    const nav = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(nav.getAllByRole('link').map((a) => a.textContent)).toEqual(['Monitor', 'Workflow', 'Stats']);
  });

  it('#/waiting renders the Monitor', async () => {
    setup('#/waiting');
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Waiting on you (2)' })).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Runs (1)' })).toBeTruthy();
    const nav = within(screen.getByRole('navigation', { name: 'Sections' }));
    expect(nav.getByRole('link', { name: 'Monitor' }).getAttribute('aria-current')).toBe('page');
  });
});
