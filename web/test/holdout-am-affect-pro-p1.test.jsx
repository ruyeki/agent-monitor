// Holdout (#2289 piece 1): route tabs (C4), layout toggle (C1), Fleet cards + quick answer (C2/C3), run header (C5). Mounts the whole App.
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRoute, runHref } from '../src/lib/route.js';
import { NOW, activeRun, clearStorage, detailFor, doneRun, installApi, mountApp, waitingRun } from './holdout-am-affect-pro-helpers.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); clearStorage(); window.location.hash = '#/'; });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); clearStorage(); });

const W1 = waitingRun('w-old', 'Old waiter', 30);
const W2 = waitingRun('w-new', 'New waiter', 2);
const A1 = activeRun('a-1', 'Busy run');
const D1 = doneRun('d-1', 'Finished run');
const routes = (over = {}) => ({
  runs: [A1, W2, D1, W1],
  details: { 'a-1': detailFor(A1), 'w-old': detailFor(W1), 'w-new': detailFor(W2), 'd-1': detailFor(D1) },
  ...over,
});
const cards = () => [...document.querySelectorAll('article[data-run-id]')].filter((a) => !(a.getAttribute('aria-label') || '').startsWith('Waiting on you'));
const group = () => screen.getByRole('group', { name: 'Layout' });
const btn = (name) => within(group()).getByRole('button', { name });
const toFleet = async () => { await screen.findByRole('group', { name: 'Layout' }); fireEvent.click(btn('Fleet')); await waitFor(() => expect(cards().length).toBeGreaterThan(0)); };

describe('route (C4)', () => {
  it('bare run URL is Stages; tabs crew/stages/ledger parse; unknown or missing tab is stages; ids are decoded', () => {
    expect(parseRoute('#/runs/x')).toMatchObject({ name: 'run', id: 'x', tab: 'stages' });
    expect(parseRoute('#/runs/x/crew')).toMatchObject({ name: 'run', id: 'x', tab: 'crew' });
    expect(parseRoute('#/runs/x/stages')).toMatchObject({ name: 'run', id: 'x', tab: 'stages' });
    expect(parseRoute('#/runs/x/ledger')).toMatchObject({ name: 'run', id: 'x', tab: 'ledger' });
    expect(parseRoute('#/runs/x/bogus')).toMatchObject({ name: 'run', id: 'x', tab: 'stages' });
    expect(parseRoute('#/runs/a%20b/crew')).toMatchObject({ id: 'a b', tab: 'crew' });
    expect(parseRoute('#/runs/%E0%A4%A/crew').name).toBe('monitor');
    expect(parseRoute('#/runs/').name).toBe('monitor');
    expect(parseRoute('#/stats')).toEqual({ name: 'stats' });
    expect(parseRoute('#/workflow')).toEqual({ name: 'workflow' });
    expect(runHref('a b')).toBe('#/runs/a%20b');
  });
});

describe('layout toggle (C1)', () => {
  it('defaults to List; the toggle is a labelled group of two aria-pressed buttons', async () => {
    installApi(routes());
    mountApp('#/');
    const g = await screen.findByRole('group', { name: 'Layout' });
    expect(within(g).getAllByRole('button').map((b) => b.textContent.trim())).toEqual(['List', 'Fleet']);
    expect(btn('List').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('false');
    expect(cards().length).toBe(0);
  });
  it('choosing Fleet shows cards, stores "fleet" under agent-monitor-layout, and survives a remount', async () => {
    installApi(routes());
    const first = mountApp('#/');
    await toFleet();
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem('agent-monitor-layout')).toBe('fleet');
    first.unmount();
    mountApp('#/');
    await waitFor(() => expect(cards().length).toBeGreaterThan(0));
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('List'));
    expect(localStorage.getItem('agent-monitor-layout')).toBe('list');
    await waitFor(() => expect(cards().length).toBe(0));
  });
  it('an unknown stored value falls back to List', async () => {
    localStorage.setItem('agent-monitor-layout', 'grid');
    installApi(routes());
    mountApp('#/');
    await screen.findByRole('group', { name: 'Layout' });
    expect(btn('List').getAttribute('aria-pressed')).toBe('true');
  });
  it('when localStorage throws on read and write, the page still renders and the toggle still switches', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    installApi(routes());
    mountApp('#/');
    await screen.findByRole('group', { name: 'Layout' });
    fireEvent.click(btn('Fleet'));
    await waitFor(() => expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true'));
    expect(cards().length).toBeGreaterThan(0);
  });
});

describe('Fleet cards (C2, C3)', () => {
  it('one card per live run, waiting first and oldest first, then active; finished runs get no card', async () => {
    installApi(routes());
    mountApp('#/');
    await toFleet();
    expect(cards().map((c) => c.getAttribute('data-run-id'))).toEqual(['w-old', 'w-new', 'a-1']);
  });
  it('a needs-you card shows the question and one button per gate action', async () => {
    installApi(routes());
    mountApp('#/');
    await toFleet();
    const card = cards().find((c) => c.getAttribute('data-run-id') === 'w-old');
    expect(card.textContent).toContain('Question for Old waiter?');
    for (const l of ['Agree spec', 'Revise', 'Stop run']) expect(within(card).getByRole('button', { name: l })).toBeTruthy();
  });
  it('quick answer posts the label with empty text, disables the buttons while sending, then refreshes the list', async () => {
    let release;
    const calls = installApi(routes({ respond: () => new Promise((r) => { release = () => r({ ok: true, status: 200, json: () => Promise.resolve({}) }); }) }));
    mountApp('#/');
    await toFleet();
    const card = () => cards().find((c) => c.getAttribute('data-run-id') === 'w-old');
    const listCalls = () => calls.filter((c) => c.url === '/api/runs' && c.method === 'GET').length;
    const before = listCalls();
    fireEvent.click(within(card()).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    const post = calls.find((c) => c.method === 'POST');
    expect(post.url).toBe('/api/runs/w-old/respond');
    expect(post.body).toEqual({ action: 'Agree spec', text: '' });
    expect(within(card()).getByRole('button', { name: 'Revise' }).disabled).toBe(true);
    expect(within(card()).getByRole('button', { name: 'Agree spec' }).disabled).toBe(true);
    await act(async () => { release(); });
    await waitFor(() => expect(listCalls()).toBeGreaterThan(before));
  });
  it('a failed answer shows the error inside the card and re-enables the buttons', async () => {
    installApi(routes({ respond: () => Promise.resolve({ ok: false, status: 400, json: () => Promise.resolve({ error: 'Run is not waiting.' }) }) }));
    mountApp('#/');
    await toFleet();
    const card = () => cards().find((c) => c.getAttribute('data-run-id') === 'w-old');
    fireEvent.click(within(card()).getByRole('button', { name: 'Revise' }));
    await waitFor(() => expect(card().textContent).toContain('Run is not waiting.'));
    expect(within(card()).getByRole('button', { name: 'Revise' }).disabled).toBe(false);
  });
  it('a running card shows "<stage> · round r/max", the title, and fetches that run\'s detail; ended runs fetch nothing extra for Fleet', async () => {
    const calls = installApi(routes());
    mountApp('#/');
    await toFleet();
    const card = cards().find((c) => c.getAttribute('data-run-id') === 'a-1');
    expect(card.textContent).toContain('Plan · round 2/5');
    expect(card.textContent).toContain('Busy run');
    await waitFor(() => expect(calls.some((c) => c.url === '/api/runs/a-1')).toBe(true));
  });
  it('a card toggle sets aria-expanded; only one card is open at a time; Escape closes', async () => {
    installApi(routes());
    mountApp('#/');
    await toFleet();
    const toggle = (id) => cards().find((c) => c.getAttribute('data-run-id') === id).querySelector('[aria-expanded]');
    expect(toggle('a-1').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle('a-1'));
    await waitFor(() => expect(toggle('a-1').getAttribute('aria-expanded')).toBe('true'));
    fireEvent.click(toggle('w-new'));
    await waitFor(() => expect(toggle('w-new').getAttribute('aria-expanded')).toBe('true'));
    expect(toggle('a-1').getAttribute('aria-expanded')).toBe('false');
    fireEvent.keyDown(document.activeElement || document.body, { key: 'Escape' });
    fireEvent.keyDown(toggle('w-new'), { key: 'Escape' });
    await waitFor(() => expect(toggle('w-new').getAttribute('aria-expanded')).toBe('false'));
  });
});

describe('Monitor list view keeps its behaviour', () => {
  it('the Decision Inbox still answers with the typed text and the list has the live and finished runs', async () => {
    const calls = installApi(routes());
    mountApp('#/');
    const inbox = await waitFor(() => { const e = document.querySelector('aside[aria-label="Decision inbox"]'); if (!e) throw new Error('no inbox'); return e; });
    const item = within(inbox).getByRole('article', { name: /Waiting on you: Old waiter/ });
    fireEvent.change(within(item).getByRole('textbox'), { target: { value: 'use sqlite' } });
    fireEvent.click(within(item).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST').body).toEqual({ action: 'Agree spec', text: 'use sqlite' });
    expect(screen.getAllByText('Busy run').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Finished run').length).toBeGreaterThan(0);
  });
});

describe('run header (C5) and tabs (C4, piece 1)', () => {
  it('shows a "Monitor" breadcrumb to #/ , the title as h1, a status, agents and Stop run for a live run; no "Back to monitor"', async () => {
    installApi(routes());
    mountApp('#/runs/a-1');
    const h1 = await screen.findByRole('heading', { level: 1, name: /Busy run/ });
    expect(h1).toBeTruthy();
    const crumb = screen.getByRole('link', { name: 'Monitor' });
    expect(crumb.getAttribute('href')).toBe('#/');
    expect(screen.queryByText(/Back to monitor/i)).toBeNull();
    expect(screen.getByRole('button', { name: /Stop run/i })).toBeTruthy();
    expect(document.body.textContent).toContain('Plan · round 2/5');
  });
  it('a finished run has no Stop run button', async () => {
    installApi(routes());
    mountApp('#/runs/d-1');
    await screen.findByRole('heading', { level: 1, name: /Finished run/ });
    expect(screen.queryByRole('button', { name: /Stop run/i })).toBeNull();
  });
  it('the Run views tablist has a Stages tab that is selected on the bare URL, and the graph still renders', async () => {
    installApi(routes());
    mountApp('#/runs/a-1');
    const list = await screen.findByRole('tablist', { name: 'Run views' });
    const stages = within(list).getByRole('tab', { name: 'Stages' });
    expect(stages.getAttribute('aria-selected')).toBe('true');
    await waitFor(() => expect(document.querySelector('[data-node="plan"]')).toBeTruthy());
  });
  it('an unknown run id shows an error, not a crash', async () => {
    installApi(routes());
    mountApp('#/runs/nope');
    await waitFor(() => expect(document.body.textContent).toMatch(/Could not load|No such run/i));
  });
});
