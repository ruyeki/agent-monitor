// Holdout: each view shows only its own content.
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { G, mount, setup, setLayout, inbox, strip, runList, cardIds, toggle, groupHeads, screen, finishedRun, activeRun, waitingRun } from './holdout-view-only-common.jsx';

setup();
const h1 = () => { const hs = document.querySelectorAll('h1'); expect(hs.length).toBe(1); return hs[0].textContent.trim(); };
const noKpi = () => expect(strip()).toBeNull();
const text = () => document.body.textContent;

describe('Needs you, list', () => {
  it('only the question cards; no KPI strip, no run list, h1 names the view', () => {
    mount(G(), { view: 'waiting' });
    expect(h1()).toBe('Needs you');
    noKpi();
    expect(inbox().querySelectorAll('article').length).toBe(2);
    expect(runList()).toBeNull();
    expect(document.querySelector('.monitor-body.inbox-only')).toBeTruthy();
    expect(text()).not.toContain('Busy a1');
    expect(text()).not.toContain('Done f1');
  });
  it('empty state is the inbox text; search does not filter the cards', () => {
    const { again } = mount(G(), { view: 'waiting', query: 'zzzz' });
    expect(inbox().querySelectorAll('article').length).toBe(2);
    again({ waiting: [], active: [activeRun('a1')], finished: [] }, { view: 'waiting', query: '' });
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    noKpi();
    expect(text()).not.toContain('Busy a1');
  });
  it('shows the Updated text and keeps the layout toggle', () => {
    mount(G(), { view: 'waiting' });
    expect(text()).toContain('Updated');
    expect(toggle()).toBeTruthy();
  });
});

describe('Running, list', () => {
  it('only the Running group; no KPI strip, no inbox, no Finished', () => {
    mount(G(), { view: 'active' });
    expect(h1()).toBe('Running');
    noKpi();
    expect(inbox()).toBeNull();
    expect(groupHeads()).toEqual(['Running']);
    expect(text()).toContain('Busy a1');
    expect(text()).not.toContain('Wait w1');
    expect(text()).not.toContain('Done f1');
  });
  it('empty state Nothing is running (with other runs present, and with no runs at all)', () => {
    const { again } = mount({ waiting: [waitingRun('w1')], active: [], finished: [finishedRun('f1')] }, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
    expect(inbox()).toBeNull();
    again({ waiting: [], active: [], finished: [] }, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
  });
  it('search filters; no-match message', () => {
    const { again } = mount(G(), { view: 'active', query: 'other' });
    expect(text()).toContain('Other job');
    expect(text()).not.toContain('Busy a1');
    again(G(), { view: 'active', query: 'zzzz' });
    expect(screen.getByText('No runs match "zzzz".')).toBeTruthy();
  });
});

describe('Finished', () => {
  it('only the Finished group, open; no KPI strip, no inbox, h1 Finished', () => {
    mount(G(), { view: 'finished' });
    expect(h1()).toBe('Finished');
    noKpi();
    expect(inbox()).toBeNull();
    expect(groupHeads()).toEqual(['Finished']);
    expect(document.querySelector('details.finished')).toBeNull(); // a plain header: folding away the only content is no use
    expect(text()).toContain('Done f1');
    expect(text()).not.toContain('Busy a1');
  });
  it('empty state No finished runs', () => {
    mount({ waiting: [waitingRun('w1')], active: [activeRun('a1')], finished: [] }, { view: 'finished' });
    expect(screen.getByText('No finished runs.')).toBeTruthy();
  });
  it('Show more paging works', () => {
    mount({ waiting: [], active: [], finished: Array.from({ length: 12 }, (_, i) => finishedRun(`f${i}`)) }, { view: 'finished' });
    fireEvent.click(screen.getByRole('button', { name: /Show 4 more/ }));
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });
  it('hides the Layout toggle, keeps the saved preference, shows the list even when saved is fleet', () => {
    setLayout('fleet');
    const { again } = mount(G(), { view: 'finished' });
    expect(toggle()).toBeNull();
    expect(localStorage.getItem('agent-monitor-layout')).toBe('fleet');
    expect(document.querySelector('section.fleet')).toBeNull();
    expect(text()).toContain('Done f1');
    expect(text()).toContain('Updated');
    expect(document.querySelector('.fleet-summary')).toBeNull();
    again(G(), { view: null });
    expect(toggle()).toBeTruthy();
    expect(document.querySelector('section.fleet')).toBeTruthy();
    expect(localStorage.getItem('agent-monitor-layout')).toBe('fleet');
  });
  it('a saved list preference is not written either', () => {
    mount(G(), { view: 'finished' });
    expect(localStorage.getItem('agent-monitor-layout')).toBeNull();
  });
  it('search filters finished; no-match message', () => {
    mount(G(), { view: 'finished', query: 'zzzz' });
    expect(screen.getByText('No runs match "zzzz".')).toBeTruthy();
  });
});

describe('Fleet layout views', () => {
  it('Needs you: only waiting cards, h1 Needs you, Updated text, no fleet summary', () => {
    setLayout('fleet');
    mount(G(), { view: 'waiting', query: 'other' });
    expect(h1()).toBe('Needs you');
    expect(cardIds()).toEqual(['w1', 'w2']);
    expect(document.querySelector('.fleet-summary')).toBeNull();
    expect(text()).toContain('Updated');
    expect(toggle()).toBeTruthy();
  });
  it('Running: only running cards filtered by search', () => {
    setLayout('fleet');
    const { again } = mount(G(), { view: 'active' });
    expect(h1()).toBe('Running');
    expect(cardIds()).toEqual(['a1', 'a2']);
    again(G(), { view: 'active', query: 'other' });
    expect(cardIds()).toEqual(['a2']);
  });
  it('empty states in fleet', () => {
    setLayout('fleet');
    const e = { waiting: [], active: [], finished: [finishedRun('f1')] };
    const { again } = mount(e, { view: 'active' });
    expect(screen.getByText('Nothing is running.')).toBeTruthy();
    again(e, { view: 'waiting' });
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    again({ waiting: [waitingRun('w1')], active: [activeRun('a1')], finished: [] }, { view: 'active', query: 'zzzz' });
    expect(screen.getByText('No runs match "zzzz".')).toBeTruthy();
  });
});

describe('no view unchanged', () => {
  it('list shows everything under the Monitor heading', () => {
    mount(G());
    expect(h1()).toBe('Monitor');
    expect(strip()).toBeTruthy();
    expect(inbox()).toBeTruthy();
    expect(groupHeads()).toEqual(['Running', 'Finished']);
  });
});
