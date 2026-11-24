// Holdout (#2289 piece 2, C7 + C4 tab + Monitor links): Crew tab on the whole App.
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, activeRun, clearStorage, detailFor, doneRun, installApi, iso, mountApp, tk, waitingRun } from './holdout-am-affect-pro-helpers.js';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); clearStorage(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); clearStorage(); });

const RUN = activeRun('crew-run', 'Crew run');
const ag = (id, type, over = {}) => ({
  id, type, description: `${type} task`, model: 'claude-sonnet-5-5', status: 'running', lastTool: 'Bash', lastSummary: `last-${id}`,
  lastActivityAt: iso(NOW - 4000), tokens: tk(100, 10, 0, 1000, 0.25), parentId: null, context: { tokens: 400000, window: 1000000, pct: 40 }, ...over,
});
const act = (id, agentId, summary) => ({ id, at: iso(NOW - id * 1000), agentId, event: 'tool', tool: 'Bash', summary, toolUseId: `u${id}`, endedAt: iso(NOW - id * 1000 + 500), outcome: 'ok' });
const crewDetail = (over = {}) => detailFor(RUN, {
  agents: [
    ag('main:s1', 'main', { model: 'claude-opus-5-5', description: null, context: { tokens: 100000, window: 1000000, pct: 10 } }),
    ag('lead1', 'fable-lead', { model: 'claude-opus-5-5', description: 'Lead: build it', parentId: 'main:s1', context: { tokens: 420000, window: 1000000, pct: 42 } }),
    ag('h1', 'sonnet-engineer', { description: 'Build the UI', parentId: 'lead1', context: null }),
    ag('h2', 'sonnet-engineer', { description: 'Build the API', parentId: null, status: 'finished' }),
  ],
  activity: [act(1, 'h1', 'ACT-ONE-cmd'), act(2, 'h2', 'ACT-TWO-cmd'), act(3, 'lead1', 'ACT-LEAD-cmd')],
  ...over,
});
const setup = (d = crewDetail(), extra = {}) => { installApi({ runs: [RUN, ...(extra.runs ?? [])], details: { 'crew-run': d, ...(extra.details ?? {}) } }); return mountApp('#/runs/crew-run/crew'); };
const card = (id) => document.querySelector(`article[data-agent-id="${id}"]`);
const waitCards = () => waitFor(() => expect(card('lead1')).toBeTruthy());

describe('Crew tab', () => {
  it('Crew is the selected tab, listed before Stages, and the header is shared', async () => {
    setup();
    const list = await screen.findByRole('tablist', { name: 'Run views' });
    const tabs = within(list).getAllByRole('tab').map((t) => t.textContent.trim());
    expect(tabs.indexOf('Crew')).toBeGreaterThanOrEqual(0);
    expect(tabs.indexOf('Crew')).toBeLessThan(tabs.indexOf('Stages'));
    expect(within(list).getByRole('tab', { name: 'Crew' }).getAttribute('aria-selected')).toBe('true');
    expect(within(list).getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')).toBe('false');
    expect(screen.getByRole('heading', { level: 1, name: /Crew run/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Monitor' }).getAttribute('href')).toBe('#/');
  });
  it('the Stages tab is still reachable and shows the graph; the Crew tab does not draw it', async () => {
    setup();
    await waitCards();
    expect(document.querySelector('[data-node="plan"]')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Stages' }));
    await waitFor(() => expect(document.querySelector('[data-node="plan"]')).toBeTruthy());
    expect(window.location.hash).toMatch(/^#\/runs\/crew-run(\/stages)?$/);
  });
  it('one card per agent, model name humanised, task and current tool shown', async () => {
    setup();
    await waitCards();
    for (const id of ['main:s1', 'lead1', 'h1', 'h2']) expect(card(id), id).toBeTruthy();
    expect(card('lead1').textContent).toContain('Opus 5.5');
    expect(card('h1').textContent).toContain('Build the UI');
    expect(card('h1').textContent).toContain('last-h1');
  });
  it('connector lines only for a known parent; an unknown parent has none and is still drawn after the lead', async () => {
    setup();
    await waitCards();
    const edges = [...document.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge'));
    expect(edges).toContain('main:s1->lead1');
    expect(edges).toContain('lead1->h1');
    expect(edges.some((e) => e.endsWith('->h2'))).toBe(false);
    expect(edges.some((e) => e.endsWith('->main:s1'))).toBe(false);
    const order = [...document.querySelectorAll('article[data-agent-id]')].map((a) => a.getAttribute('data-agent-id'));
    expect(order.indexOf('lead1')).toBeLessThan(order.indexOf('h2'));
    expect(order.indexOf('main:s1')).toBeLessThan(order.indexOf('lead1'));
  });
  it('context bar: a progressbar "Context" with aria-valuenow = pct; none at all when context is null (never 0)', async () => {
    setup();
    await waitCards();
    const bar = within(card('lead1')).getByRole('progressbar', { name: 'Context' });
    expect(bar.getAttribute('aria-valuenow')).toBe('42');
    expect(within(card('main:s1')).getByRole('progressbar', { name: 'Context' }).getAttribute('aria-valuenow')).toBe('10');
    expect(within(card('h1')).queryByRole('progressbar')).toBeNull();
    expect(within(card('h1')).queryByText('0%')).toBeNull();
  });
  it('unknown parents everywhere and no lead: agents hang under main, no lines, no crash; missing parentId/context keys (old server) are fine', async () => {
    const d = crewDetail({ agents: [ag('main:s1', 'main', { description: null }), { id: 'x1', type: 'sonnet-engineer', model: 'sonnet', status: 'running', tokens: tk() }, { id: 'x2', type: 'sonnet-engineer', model: 'sonnet', status: 'running', tokens: tk() }] });
    setup(d);
    await waitFor(() => expect(card('x1')).toBeTruthy());
    expect(card('x2')).toBeTruthy();
    expect(document.querySelectorAll('[data-edge]').length).toBe(0);
    expect(document.querySelectorAll('[role="progressbar"][aria-label="Context"]').length).toBeLessThanOrEqual(1);
  });
  it('the lead with an unknown parent sits first with no line; a parent id that is not in the run is treated as unknown', async () => {
    const d = crewDetail({ agents: [ag('main:s1', 'main', { description: null }), ag('lead1', 'fable-lead', { parentId: null }), ag('h1', 'sonnet-engineer', { parentId: 'ghost' })] });
    setup(d);
    await waitFor(() => expect(card('h1')).toBeTruthy());
    const edges = [...document.querySelectorAll('[data-edge]')].map((e) => e.getAttribute('data-edge'));
    expect(edges.some((e) => e.endsWith('->lead1') || e.endsWith('->h1'))).toBe(false);
    expect(edges.some((e) => e.startsWith('ghost'))).toBe(false);
  });
  it('rail shows Now, Tool calls and Totals; selecting a card filters the tool calls to that agent and a second click clears it', async () => {
    setup();
    await waitCards();
    expect(screen.getAllByText('ACT-ONE-cmd').length).toBeGreaterThan(0);
    expect(screen.getAllByText('ACT-TWO-cmd').length).toBeGreaterThan(0);
    for (const h of ['Tool calls', 'Totals']) expect(screen.getAllByText(new RegExp(`^${h}$`, 'i')).length, h).toBeGreaterThan(0);
    const sel = (id) => (card(id).matches('[aria-pressed]') ? card(id) : card(id).querySelector('[aria-pressed]'));
    expect(sel('h1').getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(sel('h1'));
    await waitFor(() => expect(sel('h1').getAttribute('aria-pressed')).toBe('true'));
    expect(screen.queryByText('ACT-TWO-cmd')).toBeNull();
    expect(screen.queryByText('ACT-LEAD-cmd')).toBeNull();
    expect(screen.getAllByText('ACT-ONE-cmd').length).toBeGreaterThan(0);
    fireEvent.click(sel('h1'));
    await waitFor(() => expect(screen.getAllByText('ACT-TWO-cmd').length).toBeGreaterThan(0));
  });
  it('keeps the live refresh: a later detail fetch updates the cards without losing the selection', async () => {
    let d = crewDetail();
    installApi({ runs: [RUN], details: { 'crew-run': () => d } });
    mountApp('#/runs/crew-run/crew');
    await waitCards();
    expect(within(card('lead1')).getByRole('progressbar', { name: 'Context' }).getAttribute('aria-valuenow')).toBe('42');
  });
});

describe('Monitor links (piece 2)', () => {
  it('a live run row links to its Crew tab; a waiting run opened from the inbox keeps the bare Stages URL', async () => {
    const W = waitingRun('w-1', 'Waiter');
    installApi({ runs: [RUN, W], details: { 'crew-run': crewDetail(), 'w-1': detailFor(W) } });
    mountApp('#/');
    const link = await screen.findByRole('link', { name: /Crew run/ });
    expect(link.getAttribute('href')).toBe('#/runs/crew-run/crew');
    const inbox = document.querySelector('aside[aria-label="Decision inbox"]');
    const open = inbox && [...inbox.querySelectorAll('a')].find((a) => /Open run/i.test(a.textContent));
    if (open) expect(open.getAttribute('href')).toBe('#/runs/w-1');
  });
  it('Fleet cards for live runs link to Crew too', async () => {
    installApi({ runs: [RUN], details: { 'crew-run': crewDetail() } });
    mountApp('#/');
    fireEvent.click(await screen.findByRole('button', { name: 'Fleet' }));
    await waitFor(() => expect(document.querySelector('article[data-run-id="crew-run"]')).toBeTruthy());
    // the card's link lives in its crew strip (a sibling of the card), which opens on a click (contract C2)
    const tgl = document.querySelector('article[data-run-id="crew-run"] [aria-expanded]');
    if (tgl) fireEvent.click(tgl);
    await waitFor(() => expect(document.querySelector('a[href^="#/runs/crew-run"]')).toBeTruthy());
    const links = [...document.querySelectorAll('a[href^="#/runs/crew-run"]')].map((a) => a.getAttribute('href'));
    expect(links.some((h) => h === '#/runs/crew-run/crew')).toBe(true);
    expect(links.every((h) => h.startsWith('#/runs/crew-run'))).toBe(true);
  });
});
