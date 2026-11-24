// The sidebar views (Needs you / Running / Finished) show only their own content; no view is the full Monitor (#2309).
import { fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';

const KEY = 'agent-monitor-layout';
const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
const base = { stage: 'gate1', stageName: 'Gate', round: 1, maxRounds: 5, verdict: null, actions: [{ label: 'Agree' }], textField: false, updatedAt: '2026-11-22T10:00:00Z', createdAt: '2026-11-22T09:00:00Z' };
const W = (id, title) => ({ ...base, id, title, status: 'waiting', ask: `Q ${id}?` });
const A = (id, title) => ({ ...base, id, title, status: 'active', actions: [], active: [{ id: 'verify', name: 'Verify' }] });
const F = (id, title) => ({ ...base, id, title, status: 'finished', actions: [], verdict: 'accepted' });
const G = { waiting: [W('w1', 'Alpha wait')], active: [A('a1', 'Bravo busy'), A('a2', 'Zulu other')], finished: [F('f1', 'Charlie done')] };
const EMPTY = { waiting: [], active: [], finished: [] };

beforeEach(() => {
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  globalThis.fetch = vi.fn(() => res({}));
});
afterEach(() => {
  vi.restoreAllMocks();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

const el = (groups, extra = {}) => (
  <Monitor groups={groups} query="" view={null} loadError={null} updatedAt="2026-11-22T12:00:00Z" tick={0} onDone={() => {}} {...extra} />
);
const mount = (groups, extra) => {
  const utils = render(el(groups, extra));
  return { ...utils, again: (g, e) => utils.rerender(el(g, e)) };
};
const strip = () => screen.queryByRole('region', { name: 'Today' });
const inbox = () => screen.queryByRole('complementary', { name: 'Decision inbox' });
const runList = () => screen.queryByRole('region', { name: 'Runs' });
const group = (name) => screen.queryByRole('heading', { level: 2, name: new RegExp(`^${name}`) });
const h1 = () => screen.getByRole('heading', { level: 1 }).textContent;
const layoutToggle = () => screen.queryByRole('group', { name: 'Layout' });

describe('list layout', () => {
  it('no view: the whole Monitor', () => {
    mount(G);
    expect(h1()).toBe('Monitor');
    expect(strip()).toBeTruthy();
    expect(inbox()).toBeTruthy();
    expect(group('Running')).toBeTruthy();
    expect(group('Finished')).toBeTruthy();
    expect(layoutToggle()).toBeTruthy();
    expect(screen.getByText(/^Updated/)).toBeTruthy();
  });

  it('Needs you: the inbox only', () => {
    mount(G, { view: 'waiting' });
    expect(h1()).toBe('Needs you');
    expect(strip()).toBeNull();
    expect(inbox()).toBeTruthy();
    expect(runList()).toBeNull();
    expect(group('Running')).toBeNull();
    expect(group('Finished')).toBeNull();
    expect(inbox().closest('.monitor-body').classList.contains('inbox-only')).toBe(true);
    expect(screen.getByText(/^Updated/)).toBeTruthy();
  });

  it('Needs you with nothing waiting: the inbox empty text', () => {
    mount({ ...G, waiting: [] }, { view: 'waiting' });
    expect(within(inbox()).getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(runList()).toBeNull();
  });

  it('Running: the Running group only; search filters it', () => {
    const { again } = mount(G, { view: 'active' });
    expect(h1()).toBe('Running');
    expect(strip()).toBeNull();
    expect(inbox()).toBeNull();
    expect(group('Running')).toBeTruthy();
    expect(group('Finished')).toBeNull();
    expect(screen.getByText('Bravo busy')).toBeTruthy();
    expect(screen.getByText('Zulu other')).toBeTruthy();
    expect(screen.queryByText('Alpha wait')).toBeNull();
    again(G, { view: 'active', query: 'zulu' });
    expect(screen.queryByText('Bravo busy')).toBeNull();
    expect(screen.getByText('Zulu other')).toBeTruthy();
    again(G, { view: 'active', query: 'nope' });
    expect(screen.getByText('No runs match "nope".')).toBeTruthy();
  });

  it('Running with no running runs (and with no runs at all)', () => {
    const { unmount } = mount({ ...G, active: [] }, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
    unmount();
    mount(EMPTY, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
  });

  it('Finished: the Finished group only, open, searchable', () => {
    const { again } = mount(G, { view: 'finished' });
    expect(h1()).toBe('Finished');
    expect(strip()).toBeNull();
    expect(inbox()).toBeNull();
    expect(group('Running')).toBeNull();
    expect(group('Finished')).toBeTruthy();
    expect(document.querySelector('details.finished')).toBeNull(); // plain header in this view
    expect(screen.getByText('Charlie done')).toBeTruthy();
    expect(layoutToggle()).toBeNull();
    again(G, { view: 'finished', query: 'nope' });
    expect(screen.getByText('No runs match "nope".')).toBeTruthy();
  });

  it('Finished with none', () => {
    mount({ ...G, finished: [] }, { view: 'finished' });
    expect(screen.getByText('No finished runs.')).toBeTruthy();
  });
});

describe('fleet layout (saved preference)', () => {
  beforeEach(() => localStorage.setItem(KEY, 'fleet'));
  const ids = () => [...document.querySelectorAll('article[data-run-id]')].map((a) => a.getAttribute('data-run-id'));

  it('no view: waiting and running cards, with the fleet summary', () => {
    mount(G);
    expect(h1()).toBe('Monitor');
    expect(ids()).toEqual(['w1', 'a1', 'a2']);
    expect(document.querySelector('.fleet-summary')).toBeTruthy();
  });

  it('Needs you: waiting cards only; Updated text instead of the summary', () => {
    mount(G, { view: 'waiting' });
    expect(h1()).toBe('Needs you');
    expect(ids()).toEqual(['w1']);
    expect(document.querySelector('.fleet-summary')).toBeNull();
    expect(screen.getByText(/^Updated/)).toBeTruthy();
    expect(strip()).toBeNull();
  });

  it('Running: running cards only, filtered by search', () => {
    const { again } = mount(G, { view: 'active' });
    expect(ids()).toEqual(['a1', 'a2']);
    again(G, { view: 'active', query: 'zulu' });
    expect(ids()).toEqual(['a2']);
    again(G, { view: 'active', query: 'nope' });
    expect(screen.getByText('No runs match "nope".')).toBeTruthy();
  });

  it('empty texts per view', () => {
    const { again } = mount({ ...G, waiting: [] }, { view: 'waiting' });
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    again({ ...G, active: [] }, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
    again(EMPTY, { view: null });
    expect(screen.getByText('No runs yet.')).toBeTruthy();
  });

  it('Finished forces the list, hides the toggle and keeps the saved preference', () => {
    const { again } = mount(G, { view: 'finished' });
    expect(h1()).toBe('Finished');
    expect(group('Finished')).toBeTruthy();
    expect(screen.getByText('Charlie done')).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Live runs' })).toBeNull();
    expect(layoutToggle()).toBeNull();
    expect(localStorage.getItem(KEY)).toBe('fleet');
    again(G, { view: 'active' });
    expect(screen.getByRole('region', { name: 'Live runs' })).toBeTruthy();
    expect(layoutToggle()).toBeTruthy();
    fireEvent.click(within(layoutToggle()).getByRole('button', { name: 'List' }));
    expect(localStorage.getItem(KEY)).toBe('list');
  });
});
