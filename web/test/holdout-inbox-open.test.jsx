// Holdout (am-inbox-open): every waiting question open; answering folds only that card; compact empty state; DOM order; note text.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';

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
  const groups = (w) => ({ waiting: w, active: [{ ...mk('a1'), status: 'active', title: 'Busy run' }], finished: [] });
  const el = (w, extra = {}) => <Monitor groups={groups(w)} {...props} {...extra} />;
  const utils = render(el(waiting));
  return { ...utils, onDone: props.onDone, update: (w, extra) => utils.rerender(el(w, extra)) };
}
const inbox = () => screen.getByRole('complementary', { name: 'Decision inbox' });
const item = (t) => screen.getByRole('article', { name: `Waiting on you: ${t}` });
const arts = () => [...inbox().querySelectorAll('article')];
const heading = () => within(inbox()).getByRole('heading', { level: 2 }).textContent;
const isOpen = (a) => !!a.querySelector('h3.ui-dic__title') && !a.querySelector('button.ui-dic__title--folded') && !a.querySelector('[inert]') && !a.hasAttribute('inert');

describe('inbox: every question open', () => {
  it('three waiting runs: all open with title, meta, ask, reply box, every action and Open run; nothing folded or inert', () => {
    renderMonitor([mk('w1'), mk('w2', { updatedAt: '2026-11-22T11:00:00Z' }), mk('w3', { updatedAt: '2026-11-22T12:00:00Z', textField: false, actions: [{ label: 'A' }, { label: 'B' }, { label: 'C' }] })]);
    expect(arts().length).toBe(3);
    expect(inbox().querySelectorAll('button.ui-dic__title--folded').length).toBe(0);
    expect(inbox().querySelectorAll('[inert]').length).toBe(0);
    for (const a of arts()) expect(isOpen(a)).toBe(true);
    for (const id of ['w1', 'w2', 'w3']) {
      const a = item(`Run ${id}`);
      expect(within(a).getByText(`Question for ${id}?`)).toBeTruthy();
      expect(a.querySelector('.pane-meta .mono').textContent).toBe(id);
      expect(a.querySelector('a.open-run').getAttribute('href')).toBe(`#/runs/${id}`);
    }
    expect(within(item('Run w1')).getByRole('textbox', { name: 'Reply for Run w1' })).toBeTruthy();
    expect(within(item('Run w3')).queryByRole('textbox')).toBeNull();
    expect([...item('Run w3').querySelectorAll('.ui-dic__actions button')].map((b) => b.textContent)).toEqual(['A', 'B', 'C']);
    expect(heading()).toBe('3 need your input');
  });

  it('a newcomer arrives open too, and an unchanged refresh keeps nodes, reply text and open state', () => {
    const { update } = renderMonitor([mk('w1'), mk('w2')]);
    fireEvent.change(within(item('Run w2')).getByRole('textbox'), { target: { value: 'draft two' } });
    const before = arts();
    update([mk('w1'), mk('w2')]);
    expect(arts().every((a, i) => a === before[i])).toBe(true);
    expect(within(item('Run w2')).getByRole('textbox').value).toBe('draft two');
    update([mk('w1'), mk('w2'), mk('w3', { updatedAt: '2026-11-22T13:00:00Z' })]);
    expect(isOpen(item('Run w3'))).toBe(true);
    expect(arts().every(isOpen)).toBe(true);
  });

  it('each card keeps its own reply text at the same time; the reply goes only with that card answer', async () => {
    renderMonitor([mk('w1'), mk('w2'), mk('w3')]);
    fireEvent.change(within(item('Run w1')).getByRole('textbox'), { target: { value: 'one' } });
    fireEvent.change(within(item('Run w2')).getByRole('textbox'), { target: { value: 'two' } });
    fireEvent.change(within(item('Run w3')).getByRole('textbox'), { target: { value: 'three' } });
    post = vi.fn(() => res({}));
    fireEvent.click(within(item('Run w2')).getByRole('button', { name: 'Stop run' }));
    expect(post).toHaveBeenCalledWith('/api/runs/w2/respond', { action: 'Stop run', text: 'two' });
    await waitFor(() => expect(item('Run w2').querySelector('.ui-dic__done')).toBeTruthy());
    expect(within(item('Run w1')).getByRole('textbox').value).toBe('one');
    expect(within(item('Run w3')).getByRole('textbox').value).toBe('three');
  });
});

describe('inbox: answering one card', () => {
  it('while pending only that card is disabled; the others are fully usable', async () => {
    let resolve;
    post = vi.fn(() => new Promise((r) => (resolve = r)));
    renderMonitor([mk('w1'), mk('w2'), mk('w3')]);
    fireEvent.click(within(item('Run w2')).getByRole('button', { name: 'Agree spec' }));
    expect(within(item('Run w2')).getByRole('button', { name: 'Agree spec' }).disabled).toBe(true);
    expect(within(item('Run w2')).getByRole('textbox').disabled).toBe(true);
    for (const id of ['w1', 'w3']) {
      expect(within(item(`Run ${id}`)).getByRole('button', { name: 'Agree spec' }).disabled).toBe(false);
      expect(within(item(`Run ${id}`)).getByRole('textbox').disabled).toBe(false);
    }
    await act(async () => resolve({ ok: true, status: 200, json: () => Promise.resolve({}) }));
  });

  it('confirms, then folds only that card: the others stay open and untouched; focus goes to the next open card', async () => {
    const { onDone, update } = renderMonitor([mk('w1'), mk('w2'), mk('w3')]);
    const w1 = item('Run w1'); const w2 = item('Run w2'); const w3 = item('Run w3');
    fireEvent.change(within(w3).getByRole('textbox'), { target: { value: 'keep' } });
    within(w1).getByRole('button', { name: 'Agree spec' }).focus();
    fireEvent.click(within(w1).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    expect(w1.querySelector('.ui-dic__done[role=status]').textContent).toBe('Agree spec');
    expect(heading()).toBe('2 need your input');
    update([mk('w2'), mk('w3')]);
    await waitFor(() => expect(w1.hasAttribute('data-gone') || w1.hasAttribute('hidden') || !w1.isConnected).toBe(true), { timeout: 3000 });
    expect(w1.hasAttribute('inert') || w1.hasAttribute('hidden') || !w1.isConnected).toBe(true);
    expect(isOpen(w2)).toBe(true);
    expect(isOpen(w3)).toBe(true);
    expect(within(w3).getByRole('textbox').value).toBe('keep');
    expect(w2.hasAttribute('data-gone')).toBe(false);
    expect(w3.hasAttribute('data-gone')).toBe(false);
    expect(w2.contains(document.activeElement) || w2 === document.activeElement).toBe(true);
    await act(() => new Promise((r) => setTimeout(r, 1200)));
    expect(isOpen(item('Run w2'))).toBe(true);
    expect(isOpen(item('Run w3'))).toBe(true);
  });

  it('answering the last card falls back to the heading for focus and shows All caught up', async () => {
    const { update } = renderMonitor([mk('w1')]);
    fireEvent.click(within(item('Run w1')).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(item('Run w1').querySelector('.ui-dic__done')).toBeTruthy());
    update([]);
    expect(heading()).toBe('All caught up');
    await waitFor(() => expect(document.activeElement).toBe(within(inbox()).getByRole('heading', { level: 2 })), { timeout: 3000 });
  });

  it('a rejection shows its message on that card only; every card stays open and the reply is kept', async () => {
    post = () => res({ error: 'Run is not waiting.' }, false);
    const { onDone } = renderMonitor([mk('w1'), mk('w2')]);
    fireEvent.change(within(item('Run w2')).getByRole('textbox'), { target: { value: 'keep me' } });
    fireEvent.click(within(item('Run w2')).getByRole('button', { name: 'Agree spec' }));
    const alert = await within(item('Run w2')).findByRole('alert');
    expect(alert.textContent).toBe('Run is not waiting.');
    expect(within(item('Run w1')).queryByRole('alert')).toBeNull();
    expect(within(item('Run w2')).getByRole('textbox').value).toBe('keep me');
    expect(arts().every(isOpen)).toBe(true);
    expect(onDone).not.toHaveBeenCalled();
  });
});

describe('inbox: layout contract in the DOM, empty state, note', () => {
  it('with something waiting, the inbox sits BEFORE the KPI strip and the run list, inside .monitor-body', () => {
    renderMonitor([mk('w1'), mk('w2')]);
    const strip = document.querySelector('section.stat-strip');
    const list = document.querySelector('section.run-list');
    expect(strip && list).toBeTruthy();
    expect(inbox().closest('.monitor-body')).toBe(list.closest('.monitor-body'));
    const P = Node.DOCUMENT_POSITION_FOLLOWING;
    expect(inbox().compareDocumentPosition(strip) & P).toBeTruthy();
    expect(strip.compareDocumentPosition(list) & P).toBeTruthy();
  });

  it('view=waiting: same inbox, all open, no run list', () => {
    renderMonitor([mk('w1'), mk('w2')], { view: 'waiting' });
    expect(screen.queryByRole('region', { name: 'Runs' })).toBeNull();
    expect(document.querySelector('section.run-list')).toBeNull();
    expect(arts().length).toBe(2);
    expect(arts().every(isOpen)).toBe(true);
  });

  it('nothing waiting: heading "All caught up", "Nothing is waiting on you.", no cards, no note', () => {
    renderMonitor([]);
    expect(heading()).toBe('All caught up');
    expect(within(inbox()).getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(arts().length).toBe(0);
    expect(document.querySelector('.inbox-note')).toBeNull();
  });

  it('the note says answered questions fold away and no longer says the next one opens', () => {
    renderMonitor([mk('w1'), mk('w2')]);
    const note = document.querySelector('.inbox-note');
    expect(note).toBeTruthy();
    expect(note.textContent).toMatch(/Answered questions confirm, then fold away\./);
    expect(document.body.textContent).not.toMatch(/next one opens/i);
  });
});
