// Holdout (#2289 piece 3, C9 + finished-run links): Ledger tab on the whole App.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, activeRun, clearStorage, detailFor, doneRun, installApi, iso, mountApp } from './holdout-am-affect-pro-helpers.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); clearStorage(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); clearStorage(); });

const RUN = doneRun('led-run', 'Ledger run');
const item = (id, category, tag, tagLabel, title, extra = {}) => ({ id, at: iso(NOW - 60000 + id * 1000), agentId: 'main:s1', kind: 'x', category, title, chips: ['chip-' + id], detail: `detail ${id}`, tag, tagLabel, ...extra });
const LEDGER = {
  items: [
    item(1, 'code', 'permanent', "Can't undo", 'Pushed to main'),
    item(2, 'code', 'reversible', 'Can change back', 'Committed abc1234'),
    item(3, 'tasks', 'reversible', 'Can change back', 'Set Hephaestus #2289 status'),
    item(4, 'machines', 'backup', 'Backup kept', 'Backed up the database'),
    item(5, 'machines', 'info', 'Ran once', 'Restarted the server'),
  ],
  summary: { commits: 1, files: 3, insertions: 10, deletions: 2, pushes: 1, tasks: 1, restarts: 1, total: 5, permanent: [item(1, 'code', 'permanent', "Can't undo", 'Pushed to main')] },
};
const setup = (ledger = LEDGER, run = RUN) => { installApi({ runs: [run], details: { [run.id]: detailFor(run) }, ledgers: { [run.id]: ledger } }); return mountApp(`#/runs/${run.id}/ledger`); };
const rowOf = (title) => screen.getAllByText(title).map((e) => e.closest('li[data-tag]')).find(Boolean);
const filter = () => screen.getByRole('group', { name: 'Filter' });

describe('Ledger tab', () => {
  it('Ledger is the selected tab, heading "What this run changed", every item shown with its tag label and data-tag', async () => {
    setup();
    await screen.findByRole('heading', { name: /What this run changed/ });
    const tabs = within(screen.getByRole('tablist', { name: 'Run views' }));
    expect(tabs.getByRole('tab', { name: 'Ledger' }).getAttribute('aria-selected')).toBe('true');
    expect(tabs.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('false');
    for (const [title, tag, label] of [['Pushed to main', 'permanent', "Can't undo"], ['Committed abc1234', 'reversible', 'Can change back'], ['Backed up the database', 'backup', 'Backup kept'], ['Restarted the server', 'info', 'Ran once']]) {
      await waitFor(() => expect(screen.getAllByText(title).length).toBeGreaterThan(0));
      const row = rowOf(title);
      expect(row.getAttribute('data-tag'), title).toBe(tag);
      expect(row.textContent, title).toContain(label);
    }
  });
  it('filter group: All, Code, Tasks, Servers & data with aria-pressed; All is on first; a filter hides the other categories; All restores', async () => {
    setup();
    await screen.findAllByText('Pushed to main');
    expect(within(filter()).getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['All', 'Code', 'Tasks', 'Servers & data']);
    const b = (n) => within(filter()).getByRole('button', { name: n });
    expect(b('All').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(b('Tasks'));
    await waitFor(() => expect([...document.querySelectorAll('li[data-tag]')].some((l) => l.textContent.includes('Pushed to main'))).toBe(false));
    expect(screen.getByText('Set Hephaestus #2289 status')).toBeTruthy();
    expect(b('Tasks').getAttribute('aria-pressed')).toBe('true');
    expect(b('All').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(b('Servers & data'));
    await waitFor(() => expect(screen.getByText('Restarted the server')).toBeTruthy());
    expect(screen.queryByText('Set Hephaestus #2289 status')).toBeNull();
    fireEvent.click(b('Code'));
    await waitFor(() => expect(screen.getByText('Committed abc1234')).toBeTruthy());
    expect(screen.queryByText('Restarted the server')).toBeNull();
    fireEvent.click(b('All'));
    await waitFor(() => expect(screen.getByText('Restarted the server')).toBeTruthy());
  });
  it('summary rail shows the counts and a "Can\'t be undone" card that lists the permanent items', async () => {
    setup();
    await screen.findAllByText('Pushed to main');
    expect(screen.getAllByText(/Can.t be undone/i).length).toBeGreaterThan(0);
    const card = screen.getAllByText(/Can.t be undone/i)[0].closest('section, aside, article, div');
    expect(card.parentElement.textContent).toContain('Pushed to main');
    const text = document.body.textContent;
    for (const n of ['10', '3']) expect(text).toContain(n);
  });
  it('read only: no undo, revert, rollback or restore controls', async () => {
    setup();
    await screen.findAllByText('Pushed to main');
    const names = [...document.querySelectorAll('button, [role="button"], a')].map((e) => (e.textContent + ' ' + (e.getAttribute('aria-label') || '')).toLowerCase());
    expect(names.filter((n) => /undo|revert|roll ?back|restore/.test(n))).toEqual([]);
  });
  it('empty ledger: the heading and an empty message, no rows', async () => {
    setup({ items: [], summary: { commits: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, tasks: 0, restarts: 0, total: 0, permanent: [] } });
    await screen.findByRole('heading', { name: /What this run changed/ });
    await waitFor(() => expect(document.body.textContent).toMatch(/nothing|no changes|didn.t change|hasn.t changed/i));
    expect(document.querySelectorAll('li[data-tag]').length).toBe(0);
  });
  it('a ledger request that fails shows an error, not a blank page or a crash', async () => {
    installApi({ runs: [RUN], details: { 'led-run': detailFor(RUN) }, ledgers: {} });
    mountApp('#/runs/led-run/ledger');
    await screen.findByRole('heading', { name: /What this run changed/ });
    await waitFor(() => expect(document.body.textContent).toMatch(/could not|failed|error|no ledger/i));
  });
  it('item text is rendered as text, never as HTML', async () => {
    const evil = item(9, 'code', 'info', 'Pushed', '<img src=x onerror=alert(1)>', { detail: '<script>window.__pwn=1</script>' });
    setup({ items: [evil], summary: { ...LEDGER.summary, total: 1, permanent: [] } });
    await screen.findByText('<img src=x onerror=alert(1)>');
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(window.__pwn).toBeUndefined();
  });
});

describe('Monitor links (piece 3)', () => {
  it('a finished run row links to its Ledger tab, a live one to Crew', async () => {
    const A = activeRun('live-1', 'Live one');
    installApi({ runs: [A, RUN], details: { 'live-1': detailFor(A), 'led-run': detailFor(RUN) } });
    mountApp('#/');
    const done = await screen.findByRole('link', { name: /Ledger run/ });
    expect(done.getAttribute('href')).toBe('#/runs/led-run/ledger');
    expect(screen.getByRole('link', { name: /Live one/ }).getAttribute('href')).toBe('#/runs/live-1/crew');
  });
});
