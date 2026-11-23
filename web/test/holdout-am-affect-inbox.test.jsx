// Holdout (#2288): the Decision Inbox on the Monitor page. Vitest + jsdom, fake timers.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';

const NOW = Date.parse('2026-10-27T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const wr = (id, title, ageMin = 5, over = {}) => ({
  id, title, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting',
  ask: `Question for ${title}?\nOption: pick one`, actions: [{ label: 'Agree spec' }, { label: 'Revise' }, { label: 'Stop run' }], textField: true,
  updatedAt: iso(NOW - ageMin * 60000), ...over,
});
const ar = (id, title) => ({ id, title, stage: 'plan', stageName: 'Plan', round: 0, maxRounds: 5, status: 'active', active: [{ id: 'plan', name: 'Plan' }], updatedAt: iso(NOW - 1000) });
const dr = (id, title) => ({ id, title, stage: 'done', stageName: 'Done', round: 2, maxRounds: 5, status: 'done', updatedAt: iso(NOW - 99000) });
const json = (body, ok = true, status = 200) => Promise.resolve({ ok, status, json: () => Promise.resolve(body) });

let fetchMock;
let calls;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  calls = [];
  fetchMock = vi.fn((url, opts = {}) => {
    calls.push([String(url), opts]);
    return json(String(url).startsWith('/api/stats/usage') ? { periods: { today: { total: 0, cost: 0 } } } : {});
  });
  globalThis.fetch = fetchMock;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

const mount = (groups, extra = {}) => {
  const onDone = vi.fn();
  const utils = render(<Monitor groups={groups} query="" view={null} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={onDone} {...extra} />);
  const again = (g, e = {}) => utils.rerender(<Monitor groups={g} query="" view={null} loadError={null} updatedAt={iso(NOW)} tick={0} onDone={onDone} {...extra} {...e} />);
  return { ...utils, onDone, again };
};
const flush = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
const inbox = () => document.querySelector('aside[aria-label="Decision inbox"]');
const item = (title) => document.querySelector(`article[aria-label="Waiting on you: ${title}"]`);
const respondCalls = () => calls.filter(([u]) => u.endsWith('/respond'));

describe('Decision inbox structure', () => {
  it('replaces the answer pane; the run list has no Waiting group or waiting button rows', async () => {
    mount({ waiting: [wr('w1', 'Alpha')], active: [ar('a1', 'Busy')], finished: [dr('d1', 'Old')] });
    await flush();
    expect(inbox()).toBeTruthy();
    expect(document.querySelector('aside[aria-label="Selected run"]')).toBeNull();
    expect(document.querySelector('aside.answer-pane')).toBeNull();
    const list = document.querySelector('section[aria-label="Runs"]');
    expect(within(list).queryByRole('heading', { name: /Waiting on you/ })).toBeNull();
    expect(list.querySelector('button.run-row[aria-pressed]')).toBeNull();
    expect(within(list).getByText('Busy')).toBeTruthy();
    expect(within(list).getByText('Old')).toBeTruthy();
    expect(within(list).queryByText('Alpha')).toBeNull();
    // the inbox follows the run list in the DOM
    expect(list.compareDocumentPosition(inbox()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('header counts: "2 need your input", "1 needs your input", "All caught up"; empty text visible', async () => {
    const m = mount({ waiting: [wr('w1', 'Alpha', 5), wr('w2', 'Beta', 1)], active: [], finished: [] });
    await flush();
    expect(within(inbox()).getByRole('heading', { level: 2 }).textContent).toMatch(/2 need your input/);
    m.again({ waiting: [wr('w1', 'Alpha', 5)], active: [], finished: [] });
    await flush();
    expect(within(inbox()).getByRole('heading', { level: 2 }).textContent).toMatch(/1 needs your input/);
    m.again({ waiting: [], active: [], finished: [] });
    await flush();
    expect(within(inbox()).getByRole('heading', { level: 2 }).textContent).toMatch(/All caught up/);
    const empty = inbox().querySelector('p.ui-dic__empty');
    expect(empty.textContent).toBe('Nothing is waiting on you.');
  });

  it('one item per waiting run, oldest first, each an article with data-run-id', async () => {
    mount({ waiting: [wr('w-new', 'Newest', 1), wr('w-old', 'Oldest', 90), wr('w-mid', 'Middle', 30)], active: [], finished: [] });
    await flush();
    const arts = [...inbox().querySelectorAll('article[aria-label^="Waiting on you: "]')];
    expect(arts.map((a) => a.getAttribute('data-run-id'))).toEqual(['w-old', 'w-mid', 'w-new']);
    expect(arts.map((a) => a.getAttribute('aria-label'))).toEqual(['Waiting on you: Oldest', 'Waiting on you: Middle', 'Waiting on you: Newest']);
  });

  it('the oldest item is open and the others are folded to a one-line button that is not reachable inside a closed body', async () => {
    mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    const open = item('Alpha');
    expect(within(open).getByRole('button', { name: 'Agree spec' })).toBeTruthy();
    expect(within(open).getByLabelText('Reply for Alpha')).toBeTruthy();
    const folded = item('Beta');
    const foldedTitle = within(folded).getByRole('button', { name: /Beta/ });
    expect(foldedTitle).toBeTruthy();
    // the folded item's action buttons sit inside an inert region
    const hiddenBtn = [...folded.querySelectorAll('button')].filter((b) => /Agree spec|Revise|Stop run/.test(b.textContent));
    for (const b of hiddenBtn) expect(b.closest('[inert]')).toBeTruthy();
    for (const b of within(open).getAllByRole('button')) expect(b.closest('[inert]')).toBeNull();
    fireEvent.click(foldedTitle);
    await flush();
    for (const b of [...folded.querySelectorAll('button')].filter((x) => /Agree spec/.test(x.textContent))) expect(b.closest('[inert]')).toBeNull();
  });

  it('nothing is lost: ask text via parseAsk, every action in order (primary only on the first), reply box, Open run link, Codex tag', async () => {
    const run = wr('w1', 'Alpha', 5, { provider: 'codex', ask: 'Pick a plan\nPlan A: `npm test` first\nA free paragraph' });
    mount({ waiting: [run], active: [], finished: [] });
    await flush();
    const it1 = item('Alpha');
    expect(it1.querySelector('h4.ask-heading').textContent).toBe('Pick a plan');
    expect(it1.querySelector('.ask code').textContent).toBe('npm test');
    expect(within(it1).getByText('A free paragraph')).toBeTruthy();
    expect(within(it1).getByText('Codex')).toBeTruthy();
    const btns = ['Agree spec', 'Revise', 'Stop run'].map((n) => within(it1).getByRole('button', { name: n }));
    expect(btns[0].className).toMatch(/\bprimary\b/);
    expect(btns[0].className).toContain('ui-dic__btn--primary');
    for (const b of btns.slice(1)) { expect(b.className).not.toMatch(/\bprimary\b/); expect(b.className).not.toContain('ui-dic__btn--primary'); }
    const all = [...it1.querySelectorAll('button')].filter((b) => ['Agree spec', 'Revise', 'Stop run'].includes(b.textContent.trim()));
    expect(all.map((b) => b.textContent.trim())).toEqual(['Agree spec', 'Revise', 'Stop run']);
    expect(it1.querySelector('textarea').getAttribute('placeholder')).toBe('Your reply (optional)');
    const link = it1.querySelector('a.open-run');
    expect(link.getAttribute('href')).toBe('#/runs/w1');
    expect(link.textContent).toMatch(/Open run/);
    expect(it1.textContent).toMatch(/Your solution/);
    expect(it1.textContent).toMatch(/w1/);
    expect(it1.textContent).toMatch(/1\/5/);
    expect(it1.textContent).toMatch(/ago/);
  });

  it('no reply box when the gate has no text field', async () => {
    mount({ waiting: [wr('w1', 'Alpha', 5, { textField: false })], active: [], finished: [] });
    await flush();
    expect(item('Alpha').querySelector('textarea')).toBeNull();
  });

  it('search and view never hide inbox items; view "waiting" shows the inbox only', async () => {
    const g = { waiting: [wr('w1', 'Alpha', 5)], active: [ar('a1', 'Busy')], finished: [] };
    const m = mount(g, { query: 'zzz-nothing' });
    await flush();
    expect(item('Alpha')).toBeTruthy();
    m.unmount();
    mount(g, { view: 'active' });
    await flush();
    expect(item('Alpha')).toBeTruthy();
    cleanupAll();
    mount(g, { view: 'waiting' });
    await flush();
    expect(item('Alpha')).toBeTruthy();
    expect(document.querySelector('section[aria-label="Runs"]')).toBeNull();
  });
});
function cleanupAll() { document.body.innerHTML = ''; }

describe('Decision inbox answering', () => {
  const type = (title, text) => fireEvent.change(within(item(title)).getByLabelText(`Reply for ${title}`), { target: { value: text } });

  it('posts respond with the action label and the reply text; pending disables that item; success confirms and the count drops', async () => {
    let release;
    fetchMock.mockImplementation((url, opts = {}) => {
      calls.push([String(url), opts]);
      if (String(url).endsWith('/respond')) return new Promise((r) => { release = () => r({ ok: true, status: 200, json: () => Promise.resolve({}) }); });
      return json({ periods: {} });
    });
    const m = mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    type('Alpha', 'use sqlite');
    fireEvent.click(within(item('Alpha')).getByRole('button', { name: 'Revise' }));
    await flush();
    const rc = respondCalls();
    expect(rc).toHaveLength(1);
    expect(rc[0][0]).toBe('/api/runs/w1/respond');
    expect(JSON.parse(rc[0][1].body)).toEqual({ action: 'Revise', text: 'use sqlite' });
    for (const b of within(item('Alpha')).getAllByRole('button')) if (/Agree spec|Revise|Stop run/.test(b.textContent)) expect(b.disabled).toBe(true);
    expect(within(item('Alpha')).getByLabelText('Reply for Alpha').disabled).toBe(true);
    await act(async () => { release(); await vi.advanceTimersByTimeAsync(0); });
    expect(m.onDone).toHaveBeenCalled();
    const done = item('Alpha').querySelector('.ui-dic__done[role="status"]');
    expect(done.textContent).toMatch(/Revise/);
    expect(within(inbox()).getByRole('heading', { level: 2 }).textContent).toMatch(/1 needs your input/);
  });

  it('after ~1.1 s the answered row folds away and the next folded item opens and takes focus; it leaves the DOM once the run is no longer waiting', async () => {
    const m = mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    fireEvent.click(within(item('Alpha')).getByRole('button', { name: 'Agree spec' }));
    await flush(300);
    // the live refresh drops the run from "waiting" within ~250 ms: the row still stays through confirm + fold
    m.again({ waiting: [wr('w2', 'Beta', 30)], active: [ar('w1', 'Alpha')], finished: [] });
    await flush(100);
    expect(item('Alpha')).toBeTruthy();
    expect(item('Alpha').querySelector('.ui-dic__done')).toBeTruthy();
    await flush(1500);
    const gone = item('Alpha');
    expect(!gone || gone.closest('[data-gone]') || gone.closest('[inert]')).toBeTruthy();
    for (const b of within(item('Beta')).getAllByRole('button')) expect(b.closest('[inert]')).toBeNull();
    expect(within(item('Beta')).getByRole('button', { name: 'Agree spec' })).toBeTruthy();
    expect(inbox().contains(document.activeElement)).toBe(true);
    expect(item('Alpha')?.contains(document.activeElement) ?? false).toBe(false);
    m.again({ waiting: [wr('w2', 'Beta', 30)], active: [ar('w1', 'Alpha')], finished: [] });
    await flush(300);
    expect(item('Alpha')).toBeNull();
  });

  it('failure keeps the item open, re-enables the controls, shows an alert and keeps the reply', async () => {
    fetchMock.mockImplementation((url, opts = {}) => {
      calls.push([String(url), opts]);
      return String(url).endsWith('/respond') ? json({ error: 'Run is not waiting.' }, false, 400) : json({ periods: {} });
    });
    const m = mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    type('Alpha', 'my reply');
    fireEvent.click(within(item('Alpha')).getByRole('button', { name: 'Stop run' }));
    await flush(50);
    const alert = item('Alpha').querySelector('p.error[role="alert"]');
    expect(alert.textContent).toBe('Run is not waiting.');
    expect(within(item('Alpha')).getByRole('button', { name: 'Stop run' }).disabled).toBe(false);
    expect(within(item('Alpha')).getByLabelText('Reply for Alpha').value).toBe('my reply');
    expect(item('Alpha').querySelector('.ui-dic__done')).toBeNull();
    expect(m.onDone).not.toHaveBeenCalled();
    await flush(2000);
    expect(within(item('Alpha')).getByRole('button', { name: 'Agree spec' }).closest('[inert]')).toBeNull();
    expect(item('Beta').querySelector('textarea')?.closest('[inert]')).toBeTruthy();
  });

  it('reply text is per item', async () => {
    mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    type('Alpha', 'only for alpha');
    fireEvent.click(within(item('Beta')).getByRole('button', { name: /Beta/ }));
    await flush();
    expect(within(item('Beta')).getByLabelText('Reply for Beta').value).toBe('');
    expect(within(item('Alpha')).getByLabelText('Reply for Alpha').value).toBe('only for alpha');
  });

  it('the same run waiting again on a new question is a fresh, open, answerable item', async () => {
    const m = mount({ waiting: [wr('w1', 'Alpha', 60, { stage: 'gate1' })], active: [], finished: [] });
    await flush();
    fireEvent.click(within(item('Alpha')).getByRole('button', { name: 'Agree spec' }));
    await flush(50);
    m.again({ waiting: [], active: [ar('w1', 'Alpha')], finished: [] });
    await flush(1500);
    m.again({ waiting: [wr('w1', 'Alpha', 0, { stage: 'gate2', stageName: 'Accept?', ask: 'A brand new question?', actions: [{ label: 'Accept' }, { label: 'Stop run' }] })], active: [], finished: [] });
    await flush(300);
    const it2 = item('Alpha');
    expect(it2).toBeTruthy();
    expect(it2.textContent).toMatch(/A brand new question/);
    expect(it2.querySelector('.ui-dic__done')).toBeNull();
    expect(within(it2).getByRole('button', { name: 'Accept' }).closest('[inert]')).toBeNull();
    expect(within(inbox()).getByRole('heading', { level: 2 }).textContent).toMatch(/1 needs your input/);
    fireEvent.click(within(it2).getByRole('button', { name: 'Accept' }));
    await flush(50);
    expect(respondCalls()).toHaveLength(2);
    expect(JSON.parse(respondCalls()[1][1].body).action).toBe('Accept');
  });

  it('a live refresh with the same runs does not reset which item is open nor the typed reply', async () => {
    const m = mount({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush();
    fireEvent.click(within(item('Beta')).getByRole('button', { name: /Beta/ }));
    await flush();
    type('Beta', 'draft');
    m.again({ waiting: [wr('w1', 'Alpha', 60), wr('w2', 'Beta', 30)], active: [], finished: [] });
    await flush(100);
    expect(within(item('Beta')).getByLabelText('Reply for Beta').value).toBe('draft');
    expect(within(item('Beta')).getByRole('button', { name: 'Agree spec' }).closest('[inert]')).toBeNull();
  });
});
