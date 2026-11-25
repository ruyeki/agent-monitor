import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sample } from './fixtures.js';
import { activeRun, clearStorage, detailFor, installApi, mountApp } from './holdout-am-affect-pro-helpers.js';

const run = activeRun('r1', 'Run one');
const backBtn = () => screen.queryByRole('button', { name: 'Back' });
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;

beforeEach(() => {
  clearStorage();
  window.history.replaceState(null, '');
  installApi({ runs: [run], details: { r1: detailFor(run) } });
  // the Stats and Workflow pages expect these shapes
  const base = globalThis.fetch;
  const lists = /\/api\/(stats\/versions|workflow\/versions|prices)$/;
  const json = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
  globalThis.fetch = vi.fn((url, opts) => {
    if (lists.test(String(url))) return json([]);
    if (url === '/api/workflow') return json({ published: { version: 3, workflow: sample(), publishedAt: '2026-10-20T10:00:00Z' }, draft: { workflow: sample(), errors: [] } });
    return base(url, opts);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('Back button', () => {
  it('is absent on the plain Monitor', async () => {
    mountApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    expect(backBtn()).toBeNull();
    expect(screen.queryByText('Back to monitor')).toBeNull();
  });

  it('is present on the other pages, as a focusable button', async () => {
    for (const [hash, name] of [['#/stats', 'Stats'], ['#/accounts', 'Accounts'], ['#/workflow', 'Workflow']]) {
      mountApp(hash);
      await screen.findByRole('heading', { level: 1, name });
      const b = backBtn();
      expect(b).toBeTruthy();
      expect(b.tagName).toBe('BUTTON');
      expect(b.getAttribute('type')).toBe('button');
      b.focus();
      expect(document.activeElement).toBe(b);
      cleanup();
    }
  });

  it('is on the run page before the breadcrumb, which stays', async () => {
    mountApp('#/runs/r1');
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const b = backBtn();
    const crumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(b.compareDocumentPosition(crumb) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(crumb.querySelector('a').getAttribute('href')).toBe('#/');
  });

  it('a view is in the URL, shows Back, and Back returns to the plain Monitor', async () => {
    mountApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    fireEvent.click(screen.getByRole('button', { name: /^Running/ }));
    expect(window.location.hash).toBe('#/?view=active');
    await waitFor(() => expect(h1()).toBe('Running'));
    fireEvent.click(backBtn());
    expect(window.location.hash).toBe('#/');
    await waitFor(() => expect(h1()).toBe('Monitor'));
    expect(backBtn()).toBeNull();
  });

  it('a deep link to a view opens it; clicking the open view again goes to #/', async () => {
    mountApp('#/?view=finished');
    await waitFor(() => expect(h1()).toBe('Finished'));
    expect(backBtn()).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Finished/ }));
    expect(window.location.hash).toBe('#/');
  });

  it('a search shows Back and Back clears the search', async () => {
    mountApp('#/');
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(backBtn()).toBeTruthy();
    fireEvent.click(backBtn());
    expect(search.value).toBe('');
    expect(backBtn()).toBeNull();
  });

  it('typing in the search from another page opens the Monitor', async () => {
    mountApp('#/stats');
    await screen.findByRole('heading', { level: 1, name: 'Stats' });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'r' } });
    expect(window.location.hash).toBe('#/');
  });

  it('on a run page Back goes back past the tab switches', async () => {
    mountApp('#/stats');
    await screen.findByRole('heading', { level: 1, name: 'Stats' });
    window.location.hash = '#/runs/r1';
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    window.location.hash = '#/runs/r1/crew';
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Crew' }).getAttribute('aria-selected')).toBe('true'));
    window.location.hash = '#/runs/r1/ledger';
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Ledger' }).getAttribute('aria-selected')).toBe('true'));
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    fireEvent.click(backBtn());
    expect(go).toHaveBeenCalledWith(-3);
  });

  it('a run opened by deep link keeps Back on the Monitor after tab switches', async () => {
    mountApp('#/runs/r1');
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    window.location.hash = '#/runs/r1/crew';
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Crew' }).getAttribute('aria-selected')).toBe('true'));
    window.location.hash = '#/runs/r1/ledger';
    await waitFor(() => expect(screen.getByRole('tab', { name: 'Ledger' }).getAttribute('aria-selected')).toBe('true'));
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    fireEvent.click(backBtn());
    expect(go).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
  });

  it('on a run page opened directly Back falls back to the Monitor', async () => {
    mountApp('#/runs/r1/crew');
    await screen.findByRole('navigation', { name: 'Breadcrumb' });
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    fireEvent.click(backBtn());
    expect(go).not.toHaveBeenCalled();
    expect(window.location.hash).toBe('#/');
    await screen.findByRole('heading', { level: 1, name: 'Monitor' });
  });
});
