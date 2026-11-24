// Baseline (am-inbox-open): contracts that must not change. Passes on the base commit and after the change.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';

const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 2, maxRounds: 5, status: 'waiting', verdict: null,
  ask: `Question for ${id}?`, actions: [{ label: 'Agree spec' }, { label: 'Stop run' }], textField: true, updatedAt: '2026-11-22T10:00:00Z', ...over,
});
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
let post;
beforeEach(() => { post = vi.fn(() => res({})); globalThis.fetch = vi.fn((u, o = {}) => (o.method === 'POST' ? post(u, JSON.parse(o.body)) : res({}))); });
afterEach(() => vi.restoreAllMocks());
const props = { query: '', view: null, loadError: null, updatedAt: null, tick: 0, onDone: () => {} };
const groups = { waiting: [mk('w1'), mk('w2', { updatedAt: '2026-11-22T11:00:00Z' })], active: [{ ...mk('a1'), status: 'active', title: 'Busy run' }], finished: [] };

describe('inbox baseline contracts', () => {
  it('aside.inbox-pane[Decision inbox] in .monitor-body; article rows with aria-label and data-run-id; h2 count; oldest first', () => {
    render(<Monitor groups={groups} {...props} />);
    const aside = screen.getByRole('complementary', { name: 'Decision inbox' });
    expect(aside.matches('aside.inbox-pane')).toBe(true);
    expect(aside.closest('.monitor-body')).toBeTruthy();
    expect([...aside.querySelectorAll('article')].map((a) => a.getAttribute('data-run-id'))).toEqual(['w1', 'w2']);
    expect(within(aside).getByRole('heading', { level: 2 }).textContent).toBe('2 need your input');
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w1' }).querySelector('h3.ui-dic__title').textContent).toContain('Run w1');
  });
  it('the first card shows ask, round line, reply box, actions in order; the run list holds Busy run; waiting runs are not in it', () => {
    render(<Monitor groups={groups} {...props} />);
    const a = screen.getByRole('article', { name: 'Waiting on you: Run w1' });
    expect(within(a).getByText('Question for w1?')).toBeTruthy();
    expect(a.querySelector('.pane-meta').textContent).toContain('round 2/5');
    expect([...a.querySelectorAll('.ui-dic__actions button')].map((b) => b.textContent)).toEqual(['Agree spec', 'Stop run']);
    expect(within(a).getByRole('textbox', { name: 'Reply for Run w1' }).getAttribute('placeholder')).toBe('Your reply (optional)');
    expect(screen.getByRole('region', { name: 'Runs' }).textContent).toContain('Busy run');
    expect(screen.getByRole('region', { name: 'Runs' }).querySelector('article')).toBeNull();
  });
  it('answering posts the action and the reply to /api/runs/<id>/respond and calls onDone', async () => {
    const onDone = vi.fn();
    render(<Monitor groups={groups} {...props} onDone={onDone} />);
    const a = screen.getByRole('article', { name: 'Waiting on you: Run w1' });
    fireEvent.change(within(a).getByRole('textbox'), { target: { value: 'hi' } });
    fireEvent.click(within(a).getByRole('button', { name: 'Stop run' }));
    expect(post).toHaveBeenCalledWith('/api/runs/w1/respond', { action: 'Stop run', text: 'hi' });
    await waitFor(() => expect(onDone).toHaveBeenCalled());
  });
  it('KPI strip: no Needs you tile while the inbox shows the waiting runs (the inbox heading carries the count)', () => {
    render(<Monitor groups={groups} {...props} />);
    expect(screen.getByRole('region', { name: 'Today' }).textContent).not.toMatch(/Needs you/);
  });
});
