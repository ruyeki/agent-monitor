// Baseline: what the Monitor does today with NO view, and search / paging (must stay).
import { describe, expect, it } from 'vitest';
import { fireEvent } from '@testing-library/react';
import { G, mount, setup, setLayout, inbox, strip, runList, cardIds, toggle, groupHeads, screen, finishedRun, waitingRun } from './holdout-view-only-common.jsx';

setup();
describe('no view (list)', () => {
  it('shows KPI strip, inbox with questions, Running and Finished groups, h1 Monitor, layout toggle', () => {
    mount(G());
    expect(document.querySelectorAll('h1').length).toBe(1);
    expect(document.querySelector('h1').textContent).toBe('Monitor');
    expect(strip()).toBeTruthy();
    expect(inbox().querySelectorAll('article').length).toBe(2);
    expect(runList()).toBeTruthy();
    expect(groupHeads()).toEqual(['Running', 'Finished']);
    expect(toggle()).toBeTruthy();
    expect(document.querySelector('.fleet-summary')).toBeNull();
  });
  it('messages: no runs, only waiting', () => {
    const { again } = mount({ waiting: [], active: [], finished: [] });
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    again({ waiting: [waitingRun('w1')], active: [], finished: [] });
    expect(screen.getByText('No active or finished runs.')).toBeTruthy();
  });
  it('search filters the run list, not the inbox', () => {
    mount(G(), { query: 'other' });
    expect(inbox().querySelectorAll('article').length).toBe(2);
    expect(document.body.textContent).toContain('Other job');
    expect(document.body.textContent).not.toContain('Busy a1');
  });
  it('search with no match shows the no-match message', () => {
    mount(G(), { query: 'zzzz' });
    expect(screen.getByText('No runs match "zzzz".')).toBeTruthy();
  });
  it('Finished paging: Show more reveals the next page', () => {
    const fin = Array.from({ length: 12 }, (_, i) => finishedRun(`f${i}`));
    mount({ waiting: [], active: [], finished: fin }, { query: 'f' });
    fireEvent.click(screen.getByRole('button', { name: /Show 4 more/ }));
    expect(screen.queryByRole('button', { name: /more/ })).toBeNull();
  });
});
describe('no view (fleet)', () => {
  it('shows waiting then running cards, fleet summary, no KPI strip, no inbox', () => {
    setLayout('fleet');
    mount(G());
    expect(cardIds()).toEqual(['w1', 'w2', 'a1', 'a2']);
    expect(document.querySelector('.fleet-summary')).toBeTruthy();
    expect(strip()).toBeNull();
    expect(inbox()).toBeNull();
    expect(document.querySelector('h1').textContent).toBe('Monitor');
  });
  it('fleet search never hides waiting cards', () => {
    setLayout('fleet');
    mount(G(), { query: 'other' });
    expect(cardIds()).toEqual(['w1', 'w2', 'a2']);
  });
  it('fleet empty messages', () => {
    setLayout('fleet');
    const { again } = mount({ waiting: [], active: [], finished: [] });
    expect(screen.getByText('No runs yet.')).toBeTruthy();
    again({ waiting: [], active: [], finished: [finishedRun('f1')] });
    expect(screen.getByText('No live runs.')).toBeTruthy();
  });
});
describe('toggle', () => {
  it('Fleet button saves the preference with no view', () => {
    mount(G());
    fireEvent.click(screen.getByRole('button', { name: 'Fleet' }));
    expect(localStorage.getItem('agent-monitor-layout')).toBe('fleet');
  });
});
