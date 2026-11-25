// Holdout (am-back-button), jsdom layer: Back button presence, label, view URLs. Real history stepping is in the e2e holdout.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { parseRoute } from '../src/lib/route.js';
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
const back = () => screen.queryByRole('button', { name: 'Back' });
const views = () => within(screen.getByRole('navigation', { name: 'Views' }));
const plainHash = (h) => ['', '#', '#/'].includes(h);
const mount = async (hash) => { window.location.hash = hash; const r = render(<App />); await screen.findByRole('navigation', { name: 'Views' }); return r; };

beforeEach(install);
afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

describe('route: view in the URL', () => {
  it('#/?view=… parses to the Monitor with that view; unknown view or #/waiting means no view', () => {
    for (const v of ['waiting', 'active', 'finished']) {
      const r = parseRoute(`#/?view=${v}`);
      expect(r.name).toBe('monitor');
      expect(r.view).toBe(v);
    }
    expect(parseRoute('#/?view=bogus').view || null).toBeNull();
    expect(parseRoute('#/?view=').view || null).toBeNull();
    expect(parseRoute('#/waiting').view || null).toBeNull();
    expect(parseRoute('#/').view || null).toBeNull();
    expect(parseRoute('#/?view=waiting').name).toBe('monitor');
  });
});

describe('Back button presence and label', () => {
  it('plain Monitor has no Back; #/waiting, #/?view=bogus, empty hash also none', async () => {
    for (const h of ['#/', '', '#/waiting', '#/?view=bogus']) {
      const { unmount } = await mount(h);
      expect(screen.getByRole('heading', { level: 1, name: 'Monitor' })).toBeTruthy();
      expect(back()).toBeNull();
      unmount();
    }
  });
  it('a run page (any tab) shows one real Back button', async () => {
    for (const h of ['#/runs/a1', '#/runs/a1/ledger']) {
      const { unmount } = await mount(h);
      await waitFor(() => expect(screen.getAllByRole('button', { name: 'Back' }).length).toBe(1));
      const b = back();
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      expect(b.textContent.trim()).toBe('Back');
      expect(b.querySelector('svg')).toBeTruthy();
      unmount();
    }
  });
  it('the label is never "Back to monitor" (title or aria-label included)', async () => {
    await mount('#/runs/a1');
    await waitFor(() => expect(back()).toBeTruthy());
    expect(screen.queryByRole('button', { name: /back to monitor/i })).toBeNull();
    expect(document.body.innerHTML.toLowerCase()).not.toContain('back to monitor');
  });
  it('the run breadcrumb stays', async () => {
    await mount('#/runs/a1');
    const crumb = await screen.findByRole('navigation', { name: 'Breadcrumb' });
    expect(within(crumb).getByRole('link', { name: 'Monitor' }).getAttribute('href')).toBe('#/');
  });
});

describe('views live in the URL', () => {
  it('each view button writes #/?view=… ; pressing it again goes back to the plain Monitor URL', async () => {
    await mount('#/');
    for (const [name, id] of [[/^Needs you/, 'waiting'], [/^Running/, 'active'], [/^Finished/, 'finished']]) {
      fireEvent.click(views().getByRole('button', { name }));
      await waitFor(() => expect(window.location.hash).toBe(`#/?view=${id}`));
      expect(views().getByRole('button', { name }).getAttribute('aria-pressed')).toBe('true');
      expect(back()).toBeTruthy();
      fireEvent.click(views().getByRole('button', { name }));
      await waitFor(() => expect(plainHash(window.location.hash)).toBe(true));
      await waitFor(() => expect(back()).toBeNull());
    }
  });
  it('opening #/?view=active directly shows the Running view (survives a reload)', async () => {
    await mount('#/?view=active');
    expect(screen.getByRole('heading', { level: 1, name: 'Running' })).toBeTruthy();
    expect(views().getByRole('button', { name: /^Running/ }).getAttribute('aria-pressed')).toBe('true');
    expect(back()).toBeTruthy();
  });
  it('a hash change (as browser Back/Forward do) moves between views', async () => {
    await mount('#/?view=waiting');
    await screen.findByRole('heading', { level: 1, name: 'Needs you' });
    window.location.hash = '#/?view=finished';
    await screen.findByRole('heading', { level: 1, name: 'Finished' });
    window.location.hash = '#/';
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    expect(back()).toBeNull();
  });
});

describe('Back actions without history', () => {
  it('Back on a view returns to the plain Monitor and clears the view', async () => {
    await mount('#/?view=finished');
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    await waitFor(() => expect(plainHash(window.location.hash)).toBe(true));
    expect(views().getByRole('button', { name: /^Finished/ }).getAttribute('aria-pressed')).toBe('false');
    expect(back()).toBeNull();
  });
  it('Back with a search typed (no view) clears the search and removes Back', async () => {
    await mount('#/');
    const box = screen.getByRole('searchbox', { name: 'Search runs' });
    fireEvent.change(box, { target: { value: 'Busy' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.getByRole('searchbox', { name: 'Search runs' }).value).toBe(''));
    await waitFor(() => expect(back()).toBeNull());
    expect(screen.getByText('Done one')).toBeTruthy();
  });
  it('Back on a view with a search clears both', async () => {
    await mount('#/?view=active');
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'zzz' } });
    fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    expect(screen.getByRole('searchbox', { name: 'Search runs' }).value).toBe('');
  });
  it('Back on a deep-linked run (no in-app history) lands on the Monitor', async () => {
    for (const h of ['#/runs/a1/crew', '#/runs/a1']) {
      const { unmount } = await mount(h);
      fireEvent.click(await screen.findByRole('button', { name: 'Back' }));
      await screen.findByRole('heading', { level: 1, name: 'Monitor' });
      expect(plainHash(window.location.hash)).toBe(true);
      unmount();
    }
  });
});
