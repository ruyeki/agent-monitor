// Baseline (am-back-button): behaviour of the touched code on the base commit that must survive the change.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { TopBar } from '../src/editor/TopBar.jsx';
import { parseRoute, runHref } from '../src/lib/route.js';
import { activeRun, detailFor, doneRun, waitingRun } from './holdout-am-affect-pro-helpers.js';

const runs = () => [waitingRun('w1', 'Wait one'), activeRun('a1', 'Busy one'), doneRun('d1', 'Done one')];
const j = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
const install = () => {
  globalThis.EventSource = class { close() {} };
  globalThis.fetch = vi.fn((url, opts = {}) => {
    if (opts.method === 'POST') return j({});
    if (url === '/api/runs') return j(runs());
    const m = /^\/api\/runs\/([^/?]+)/.exec(url);
    if (m) return j(detailFor(runs().find((r) => r.id === m[1]) || activeRun(m[1], m[1])));
    return j({});
  });
};
const views = () => within(screen.getByRole('navigation', { name: 'Views' }));

describe('baseline route helpers', () => {
  it('parseRoute and runHref', () => {
    expect(parseRoute('#/')).toEqual({ name: 'monitor' });
    expect(parseRoute('')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
    expect(parseRoute('#/accounts')).toEqual({ name: 'accounts' });
    expect(parseRoute('#/runs/a1/ledger')).toEqual({ name: 'run', id: 'a1', tab: 'ledger' });
    expect(parseRoute('#/runs/a1/bogus')).toEqual({ name: 'run', id: 'a1', tab: 'stages' });
    expect(parseRoute('#/waiting')).toEqual({ name: 'monitor' });
    expect(runHref('a b', 'crew')).toBe('#/runs/a%20b/crew');
  });
});

describe('baseline App views and search', () => {
  beforeEach(() => { install(); window.location.hash = '#/'; });
  afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

  it('plain Monitor: h1 Monitor, three view buttons, none pressed', async () => {
    render(<App />);
    await screen.findByText('Busy one');
    expect(screen.getByRole('heading', { level: 1, name: 'Monitor' })).toBeTruthy();
    for (const n of [/^Needs you/, /^Running/, /^Finished/]) expect(views().getByRole('button', { name: n }).getAttribute('aria-pressed')).toBe('false');
  });
  it('clicking a view shows its h1 and presses it; clicking it again returns to the full Monitor', async () => {
    render(<App />);
    await screen.findByText('Busy one');
    fireEvent.click(views().getByRole('button', { name: /^Running/ }));
    await screen.findByRole('heading', { level: 1, name: 'Running' });
    expect(views().getByRole('button', { name: /^Running/ }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(views().getByRole('button', { name: /^Running/ }));
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
  });
  it('search filters the Monitor and keeps its value', async () => {
    render(<App />);
    await screen.findByText('Busy one');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'Busy' } });
    await waitFor(() => expect(screen.queryByText('Done one')).toBeNull());
    expect(screen.getByText('Busy one')).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Search runs' }).value).toBe('Busy');
  });
  it('typing in the search from another page lands on the Monitor', async () => {
    window.location.hash = '#/runs/a1';
    render(<App />);
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search runs' }), { target: { value: 'x' } });
    await waitFor(() => expect(['', '#', '#/']).toContain(window.location.hash));
  });
});

describe('baseline run page and standalone heads', () => {
  beforeEach(() => { install(); });
  afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

  it('run page keeps the Monitor breadcrumb and tab links', async () => {
    window.location.hash = '#/runs/a1';
    render(<App />);
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Monitor' }).getAttribute('href')).toBe('#/');
    expect(screen.getByRole('heading', { level: 1 })).toBeTruthy();
  });
  it('page heads rendered without App carry no Back button', () => {
    const { container } = render(<TopBar published={null} status="saved" versions={[]} onPublish={() => {}} onDiscard={() => {}} onLoadVersion={() => {}} onLayout={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Back' })).toBeNull();
    expect(container.querySelector('h1').textContent).toBe('Workflow');
  });
});
