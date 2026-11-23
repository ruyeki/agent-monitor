// Decision inbox on the Monitor (vendored affectUI decision-inbox, adapted): open/folded items, N actions, reply,
// pending, confirm then fold with the row kept in place, failure, fresh items, empty state, stable live refresh.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';
import { DecisionInbox } from '../src/vendor/affectui/decision-inbox.tsx';

const LONG = '[CloudLab] T10.10 template requests: a new table?\nBackground: lives in `requests` table.\nProposal: a new table.\nOptions: A = new / B = type';
const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting', verdict: null,
  ask: `Question for ${id}?`, actions: [{ label: 'Agree spec' }, { label: 'Stop run' }], textField: true, updatedAt: '2026-11-22T10:00:00Z', ...over,
});
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });

let post;
beforeEach(() => {
  post = () => res({});
  globalThis.fetch = vi.fn((url, opts = {}) => (opts.method === 'POST' ? post(url, JSON.parse(opts.body)) : res({})));
});
afterEach(() => vi.restoreAllMocks());

function renderMonitor(waiting, more = {}) {
  const props = { query: '', view: null, loadError: null, updatedAt: null, tick: 0, onDone: vi.fn(), ...more };
  const el = (w, extra = {}) => <Monitor groups={{ waiting: w, active: [], finished: [] }} {...props} {...extra} />;
  const utils = render(el(waiting));
  return { ...utils, onDone: props.onDone, update: (w, extra) => utils.rerender(el(w, extra)) };
}
const inbox = () => screen.getByRole('complementary', { name: 'Decision inbox' });
const item = (title) => screen.getByRole('article', { name: `Waiting on you: ${title}` });
const order = () => [...inbox().querySelectorAll('article')].map((a) => a.getAttribute('data-run-id'));
const bodyOf = (a) => a.querySelector('.ui-dic__body');
const heading = () => within(inbox()).getByRole('heading', { level: 2 }).textContent;
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
};

describe('Decision inbox on the Monitor', () => {
  it('lists the waiting runs oldest first in aside.inbox-pane; every item is open (no folded lines, no inert bodies)', () => {
    renderMonitor([mk('w2', { updatedAt: '2026-11-22T11:00:00Z' }), mk('w1', { updatedAt: '2026-11-22T09:00:00Z' }), mk('w3', { updatedAt: '2026-11-22T12:00:00Z' })]);
    expect(inbox().matches('aside.inbox-pane')).toBe(true);
    expect(order()).toEqual(['w1', 'w2', 'w3']);
    expect(heading()).toBe('3 need your input');
    const w1 = item('Run w1');
    expect(within(w1).getByRole('heading', { level: 3 }).textContent).toBe('Run w1');
    expect(bodyOf(w1).hasAttribute('inert')).toBe(false);
    expect(within(w1).getByText('Question for w1?')).toBeTruthy();
    const ta = within(w1).getByRole('textbox', { name: 'Reply for Run w1' });
    expect(ta.getAttribute('placeholder')).toBe('Your reply (optional)');
    expect(w1.querySelector('a.open-run').getAttribute('href')).toBe('#/runs/w1');
    const w2 = item('Run w2');
    expect(within(w2).getByRole('heading', { level: 3 }).textContent).toBe('Run w2');
    expect(bodyOf(w2).hasAttribute('inert')).toBe(false);
    expect(within(w2).getByText('Question for w2?')).toBeTruthy();
    expect(inbox().querySelector('button.ui-dic__title--folded')).toBeNull();
    expect(inbox().querySelector('.ui-dic__body[inert]')).toBeNull();
    // The run list no longer has a waiting group; the waiting runs are only in the inbox.
    expect(document.querySelector('section[aria-labelledby="group-waiting"]')).toBeNull();
    expect(screen.getByRole('region', { name: 'Runs' }).querySelector('article')).toBeNull();
  });

  it('every item shows its ask and Open run link without any click', () => {
    renderMonitor([mk('w1'), mk('w2')]);
    const w2 = item('Run w2');
    expect(within(w2).getByRole('heading', { level: 3 }).textContent).toBe('Run w2');
    expect(bodyOf(w2).hasAttribute('inert')).toBe(false);
    expect(within(w2).getByText('Question for w2?')).toBeTruthy();
    expect(within(w2).getByRole('link', { name: 'Open run →' }).getAttribute('href')).toBe('#/runs/w2');
    expect(bodyOf(item('Run w1')).hasAttribute('inert')).toBe(false);
  });

  it('shows every action in order (only the first primary), the full parseAsk ask, the meta line and the Codex tag; no reply box without textField', () => {
    const run = mk('c1', { ask: LONG, provider: 'codex', textField: false, round: 2, actions: [{ label: 'Resume' }, { label: 'Stop run' }, { label: 'Retry' }] });
    renderMonitor([run]);
    const a = item('Run c1');
    const btns = [...a.querySelectorAll('.ui-dic__actions button')];
    expect(btns.map((b) => b.textContent)).toEqual(['Resume', 'Stop run', 'Retry']);
    expect(btns.map((b) => b.classList.contains('primary') && b.classList.contains('ui-dic__btn--primary'))).toEqual([true, false, false]);
    expect(btns.slice(1).some((b) => b.classList.contains('primary') || b.classList.contains('ui-dic__btn--primary'))).toBe(false);
    expect(a.querySelector('h4.ask-heading').textContent).toBe('[CloudLab] T10.10 template requests: a new table?');
    expect([...a.querySelectorAll('.ask-label')].map((l) => l.textContent)).toEqual(['Background', 'Proposal', 'Options']);
    expect(a.querySelector('.ask code').textContent).toBe('requests');
    expect(within(within(a).getByRole('heading', { level: 3 })).getByText('Codex')).toBeTruthy();
    const meta = a.querySelector('.pane-meta');
    expect(within(meta).getByRole('img', { name: 'Waiting on you' })).toBeTruthy();
    expect(meta.querySelector('.mono').textContent).toBe('c1');
    expect(meta.textContent).toContain('Your solution');
    expect(meta.textContent).toContain('round 2/5');
    expect(within(a).queryByRole('textbox')).toBeNull();
  });

  it('sends the typed reply with the chosen action; while pending only that item is disabled', async () => {
    const d = deferred();
    post = vi.fn(() => d.promise);
    renderMonitor([mk('w1'), mk('w2')]);
    const w1 = item('Run w1');
    fireEvent.change(within(w1).getByRole('textbox'), { target: { value: 'use sqlite' } });
    fireEvent.click(within(w1).getByRole('button', { name: 'Stop run' }));
    expect(post).toHaveBeenCalledWith('/api/runs/w1/respond', { action: 'Stop run', text: 'use sqlite' });
    expect(within(w1).getByRole('button', { name: 'Agree spec' }).disabled).toBe(true);
    expect(within(w1).getByRole('button', { name: 'Stop run' }).disabled).toBe(true);
    expect(within(w1).getByRole('textbox').disabled).toBe(true);
    const w2 = item('Run w2');
    expect(within(w2).getByRole('button', { name: 'Agree spec' }).disabled).toBe(false);
    expect(within(w2).getByRole('textbox').disabled).toBe(false);
    await act(async () => d.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
  });

  it('success confirms, keeps the row in place after the run leaves waiting, then folds it, keeps the others open and moves focus to the next open one', async () => {
    const { onDone, update } = renderMonitor([mk('w1'), mk('w2'), mk('w3')]);
    const w1 = item('Run w1');
    fireEvent.click(within(w1).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const done = w1.querySelector('.ui-dic__done[role=status]');
    expect(done.textContent).toBe('Agree spec');
    expect(heading()).toBe('2 need your input');
    expect(within(w1).queryByRole('button', { name: 'Agree spec' })).toBeNull();
    // The live refresh drops the run from `waiting` well before the fold: the row stays where it was.
    update([mk('w2'), mk('w3')]);
    expect(order()).toEqual(['w1', 'w2', 'w3']);
    expect(item('Run w1')).toBe(w1);
    expect(w1.hasAttribute('data-gone')).toBe(false);
    expect(w1.querySelector('.ui-dic__done[role=status]').textContent).toBe('Agree spec');
    expect(heading()).toBe('2 need your input');
    await waitFor(() => expect(w1.hasAttribute('data-gone')).toBe(true), { timeout: 2000 });
    expect(w1.hasAttribute('inert')).toBe(true);
    const w2 = item('Run w2');
    expect(within(w2).getByRole('heading', { level: 3 }).textContent).toBe('Run w2');
    expect(bodyOf(w2).hasAttribute('inert')).toBe(false);
    expect(bodyOf(item('Run w3')).hasAttribute('inert')).toBe(false);
    expect(document.activeElement).toBe(w2);
    await waitFor(() => expect(order()).toEqual(['w2', 'w3']), { timeout: 2000 });
    expect(w1.isConnected).toBe(false);
  });

  it('a failure shows the error, keeps the item open, re-enables the controls and keeps the reply', async () => {
    post = () => res({ error: 'Run is not waiting.' }, false);
    const { onDone } = renderMonitor([mk('w1'), mk('w2')]);
    const w1 = item('Run w1');
    fireEvent.change(within(w1).getByRole('textbox'), { target: { value: 'keep me' } });
    fireEvent.click(within(w1).getByRole('button', { name: 'Agree spec' }));
    const alert = await within(w1).findByRole('alert');
    expect(alert.matches('p.error')).toBe(true);
    expect(alert.textContent).toBe('Run is not waiting.');
    expect(within(w1).getByRole('button', { name: 'Agree spec' }).disabled).toBe(false);
    expect(within(w1).getByRole('textbox').disabled).toBe(false);
    expect(within(w1).getByRole('textbox').value).toBe('keep me');
    expect(w1.querySelector('.ui-dic__done')).toBeNull();
    expect(within(w1).getByRole('heading', { level: 3 })).toBeTruthy();
    expect(heading()).toBe('2 need your input');
    expect(onDone).not.toHaveBeenCalled();
    // Trying again clears the old error.
    post = () => res({});
    fireEvent.click(within(w1).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(w1.querySelector('.ui-dic__done')).toBeTruthy());
    expect(within(w1).queryByRole('alert')).toBeNull();
  });

  it('the same run waiting on a new question is a fresh item in the same row, with an empty reply', async () => {
    const { onDone, update } = renderMonitor([mk('w1'), mk('w2')]);
    const w1 = item('Run w1');
    fireEvent.change(within(w1).getByRole('textbox'), { target: { value: 'first answer' } });
    fireEvent.click(within(w1).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    update([mk('w1', { stage: 'gate2', ask: 'A new question?', actions: [{ label: 'Accept' }, { label: 'Stop run' }] }), mk('w2')]);
    const fresh = screen.getAllByRole('article', { name: 'Waiting on you: Run w1' });
    expect(fresh.length).toBe(1);
    expect(within(fresh[0]).getByText('A new question?')).toBeTruthy();
    expect(within(fresh[0]).getByRole('button', { name: 'Accept' }).disabled).toBe(false);
    expect(fresh[0].querySelector('.ui-dic__done')).toBeNull();
    expect(within(fresh[0]).getByRole('textbox').value).toBe('');
    expect(heading()).toBe('2 need your input');
    // Never suppressed later by the earlier answer's fold.
    await act(() => new Promise((r) => setTimeout(r, 1800)));
    const after = item('Run w1');
    expect(after.hasAttribute('data-gone')).toBe(false);
    expect(within(after).getByRole('button', { name: 'Accept' })).toBeTruthy();
    expect(order()).toEqual(['w1', 'w2']);
  });

  it('nothing waiting: All caught up and "Nothing is waiting on you."; one item: "1 needs your input"', () => {
    const { update } = renderMonitor([]);
    expect(heading()).toBe('All caught up');
    expect(inbox().querySelector('p.ui-dic__empty').textContent).toBe('Nothing is waiting on you.');
    expect(screen.queryByRole('article')).toBeNull();
    update([mk('w1')]);
    expect(heading()).toBe('1 needs your input');
    expect(inbox().querySelector('p.ui-dic__empty')).toBeNull();
    expect(within(item('Run w1')).getByRole('heading', { level: 3 })).toBeTruthy(); // a newcomer opens
  });

  it('a live refresh with unchanged data keeps the same nodes, open state and reply text; a newcomer arrives open', () => {
    const { update } = renderMonitor([mk('w1'), mk('w2')]);
    fireEvent.change(within(item('Run w1')).getByRole('textbox'), { target: { value: 'draft' } });
    const before = [...inbox().querySelectorAll('article, textarea, .ui-dic__btn')];
    update([mk('w1'), mk('w2')]);
    const after = [...inbox().querySelectorAll('article, textarea, .ui-dic__btn')];
    expect(after.length).toBe(before.length);
    expect(after.every((el, i) => el === before[i])).toBe(true);
    expect(within(item('Run w1')).getByRole('textbox').value).toBe('draft');
    expect(bodyOf(item('Run w2')).hasAttribute('inert')).toBe(false);
    update([mk('w1'), mk('w2'), mk('w3', { updatedAt: '2026-11-22T13:00:00Z' })]);
    expect(bodyOf(item('Run w3')).hasAttribute('inert')).toBe(false);
    expect(item('Run w1')).toBe(before[0]);
  });

  it('search and views never hide inbox items; the Waiting view shows the inbox without the run list', () => {
    const groups = { waiting: [mk('w1')], active: [{ ...mk('a1'), status: 'active', title: 'Busy run' }], finished: [] };
    const props = { loadError: null, updatedAt: null, tick: 0, onDone: () => {} };
    const { rerender } = render(<Monitor groups={groups} query="zzz" view={null} {...props} />);
    expect(screen.getByText('No runs match "zzz".')).toBeTruthy();
    expect(item('Run w1')).toBeTruthy();
    rerender(<Monitor groups={groups} query="" view="active" {...props} />);
    expect(screen.getByText('Busy run')).toBeTruthy();
    expect(item('Run w1')).toBeTruthy();
    rerender(<Monitor groups={groups} query="" view="waiting" {...props} />);
    expect(screen.queryByRole('region', { name: 'Runs' })).toBeNull();
    expect(screen.queryByText('Busy run')).toBeNull();
    expect(inbox().closest('.monitor-body').classList.contains('inbox-only')).toBe(true);
    expect(item('Run w1')).toBeTruthy();
    // Only waiting runs: the run list says so instead of "No runs yet."
    rerender(<Monitor groups={{ waiting: [mk('w1')], active: [], finished: [] }} query="" view={null} {...props} />);
    expect(screen.getByText('No active or finished runs.')).toBeTruthy();
    expect(item('Run w1')).toBeTruthy();
  });
});

describe('DecisionInbox (vendored)', () => {
  it('calls onDecide with the chosen label of any of N actions, folds after the confirmation and falls back to the heading for focus', async () => {
    const onDecide = vi.fn(() => Promise.resolve());
    const d = { id: 'a', title: 'Pick one', actions: ['One', 'Two', 'Three', 'Four'] };
    const { container } = render(<DecisionInbox decisions={[d]} onDecide={onDecide} />);
    expect(container.querySelectorAll('.ui-dic__btn').length).toBe(4);
    fireEvent.click(screen.getByRole('button', { name: 'Three' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Three'));
    expect(onDecide).toHaveBeenCalledWith(d, 'Three');
    expect(screen.getByRole('heading', { level: 2 }).textContent).toBe('All caught up');
    const row = container.querySelector('article.ui-dic__row');
    await waitFor(() => expect(row.hasAttribute('data-gone')).toBe(true), { timeout: 2000 });
    expect(document.activeElement).toBe(screen.getByRole('heading', { level: 2 }));
    // Still in `decisions`: the folded row stays (as upstream), inert.
    await act(() => new Promise((r) => setTimeout(r, 700)));
    expect(row.isConnected).toBe(true);
    expect(row.hasAttribute('inert')).toBe(true);
    expect(row.hidden).toBe(true); // no empty grid cell once folded
  });

  it('does not steal focus from elsewhere when an answered item folds', async () => {
    const outside = document.createElement('input');
    document.body.append(outside);
    render(<DecisionInbox decisions={[{ id: 'a', title: 'A', actions: ['Yes'] }, { id: 'b', title: 'B', actions: ['Yes'] }]} onDecide={() => Promise.resolve()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Yes' })[0]);
    await waitFor(() => expect(screen.getByRole('status')).toBeTruthy());
    outside.focus();
    await act(() => new Promise((r) => setTimeout(r, 1300)));
    expect(screen.getByRole('heading', { level: 3, name: 'B' })).toBeTruthy(); // the other one stays open
    expect(document.activeElement).toBe(outside);
    outside.remove();
  });
});
