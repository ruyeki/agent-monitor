// The Monitor layout toggle (contract C1) and the Fleet layout (contract C2): cards, quick answers, crew strip.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Monitor } from '../src/Monitor.jsx';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const KEY = 'agent-monitor-layout';
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
const tk = (total, cost) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost });

const waitingRun = (id, ageMin, over = {}) => ({
  id, title: `Wait ${id}`, stage: 'gate2', stageName: 'Gate 2: accept', round: 1, maxRounds: 5, status: 'waiting', ask: 'Accept, push and open the PR?\nBackground: all green',
  actions: [{ label: 'Accept' }, { label: 'Request changes' }, { label: 'Stop run' }], textField: true, createdAt: iso(NOW - 3_900_000), updatedAt: iso(NOW - ageMin * 60_000), ...over,
});
const activeRun = (id, over = {}) => ({
  id, title: `Busy ${id}`, stage: 'verify', stageName: 'Verify', round: 2, maxRounds: 5, status: 'active', active: [{ id: 'verify', name: 'Verify' }], actions: [],
  createdAt: iso(NOW - 720_000), updatedAt: iso(NOW - 1000), ...over,
});
const detailOf = (run) => ({
  run,
  workflow: sample(),
  visits: [{ node: 'plan', outcome: 'done', enteredAt: iso(NOW - 600_000), leftAt: iso(NOW - 300_000) }, { node: 'verify', outcome: null, enteredAt: iso(NOW - 300_000), leftAt: null }],
  nodes: {},
  agents: [
    { id: 'main:s1', type: 'main', status: 'running', model: 'claude-opus-5-5', description: null, lastActivityAt: iso(NOW - 60_000), tokens: tk(10, 0.41) },
    { id: 'a-lead', type: 'fable-lead', status: 'running', model: 'claude-opus-5-5', description: 'Lead: steer the build', lastActivityAt: iso(NOW - 30_000), tokens: tk(10, 0.96) },
    { id: 'a-ver', type: 'sonnet-engineer', status: 'running', model: 'claude-sonnet-5-5', description: 'Verifier: run the tests', lastActivityAt: iso(NOW - 2000), tokens: tk(10, 0.31) },
    { id: 'a-old', type: 'sonnet-engineer', status: 'finished', model: 'claude-sonnet-5-5', description: 'Build the first piece', lastActivityAt: iso(NOW - 400_000), tokens: tk(0, 0) },
  ],
  activity: [{ id: 9, at: iso(NOW - 2000), agentId: 'a-ver', event: 'tool', tool: 'Bash', summary: 'npx vitest run', toolUseId: 'u9', endedAt: null, outcome: null }],
  tokens: { total: tk(40, 1.86) },
  durationMs: 720_000,
});

let post;
let runsById;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
  post = vi.fn(() => res({}));
  runsById = {};
  globalThis.fetch = vi.fn((url, opts = {}) => {
    if (opts.method === 'POST') return post(String(url), JSON.parse(opts.body));
    const m = /^\/api\/runs\/([^/]+)$/.exec(String(url));
    if (m && runsById[decodeURIComponent(m[1])]) return res(detailOf(runsById[decodeURIComponent(m[1])]));
    if (String(url).startsWith('/api/stats/usage')) return res({ periods: { today: { total: 41_200_000, cacheRead: 35_432_000, cost: 18.4 } } });
    return res({});
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  try {
    localStorage.clear();
  } catch {
    /* ignore */
  }
});

function mount(groups, extra = {}) {
  for (const r of [...groups.waiting, ...groups.active, ...groups.finished]) runsById[r.id] = r;
  const onDone = vi.fn();
  const props = { query: '', view: null, loadError: null, updatedAt: iso(NOW), tick: 0, onDone, ...extra };
  const utils = render(<Monitor groups={groups} {...props} />);
  return { ...utils, onDone, again: (g, e = {}) => utils.rerender(<Monitor groups={g} {...props} {...e} />) };
}
const layout = () => screen.getByRole('group', { name: 'Layout' });
const btn = (name) => within(layout()).getByRole('button', { name });
const card = (id) => document.querySelector(`article[data-run-id="${id}"]`);
const toggleOf = (id) => card(id).querySelector('button[aria-expanded]');
const strip = () => document.querySelector('section[aria-label^="Crew of "]');

describe('layout toggle (C1)', () => {
  it('defaults to List; Fleet swaps the list and inbox for run cards and is remembered in localStorage', async () => {
    const g = { waiting: [waitingRun('w1', 10)], active: [activeRun('a1')], finished: [] };
    const { unmount } = mount(g);
    expect(btn('List').getAttribute('aria-pressed')).toBe('true');
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('false');
    expect(screen.getByRole('region', { name: 'Runs' })).toBeTruthy();
    expect(screen.getByRole('complementary', { name: 'Decision inbox' })).toBeTruthy();
    fireEvent.click(btn('Fleet'));
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true');
    expect(localStorage.getItem(KEY)).toBe('fleet');
    expect(screen.getByRole('region', { name: 'Live runs' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Runs' })).toBeNull();
    expect(screen.queryByRole('complementary', { name: 'Decision inbox' })).toBeNull();
    unmount();
    mount(g);
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('region', { name: 'Live runs' })).toBeTruthy();
    fireEvent.click(btn('List'));
    expect(localStorage.getItem(KEY)).toBe('list');
    expect(screen.getByRole('region', { name: 'Runs' })).toBeTruthy();
  });

  it('works when storage throws: List by default, and the toggle still switches', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
      clear: () => {},
    });
    mount({ waiting: [], active: [activeRun('a1')], finished: [] });
    expect(btn('List').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('Fleet'));
    expect(btn('Fleet').getAttribute('aria-pressed')).toBe('true');
    expect(card('a1')).toBeTruthy();
  });

  it('an unknown stored value falls back to List', () => {
    localStorage.setItem(KEY, 'grid');
    mount({ waiting: [], active: [activeRun('a1')], finished: [] });
    expect(btn('List').getAttribute('aria-pressed')).toBe('true');
  });
});

describe('Fleet (C2)', () => {
  beforeEach(() => localStorage.setItem(KEY, 'fleet'));

  it('one article per live run: waiting first (oldest first), then running; finished runs are not cards', async () => {
    mount({ waiting: [waitingRun('w-new', 2), waitingRun('w-old', 90)], active: [activeRun('a1'), activeRun('a2')], finished: [{ ...activeRun('d1'), status: 'done' }] });
    const ids = [...screen.getByRole('region', { name: 'Live runs' }).querySelectorAll('article[data-run-id]')].map((a) => a.getAttribute('data-run-id'));
    expect(ids).toEqual(['w-old', 'w-new', 'a1', 'a2']);
  });

  it('a running card shows the stepper, "<stage> · round r/max", the working agent and its call, avatars, cost and run time', async () => {
    mount({ waiting: [], active: [activeRun('a1')], finished: [] });
    const c = card('a1');
    expect(c.textContent).toContain('Verify · round 2/5');
    await waitFor(() => expect(c.querySelector('.act').textContent).toBe('verifier Bash npx vitest run'));
    // sample(): plan is a fix-round target and gate2 the loop decision (the layout's side column), so the stepper is verify, pr
    const steps = [...c.querySelectorAll('.steps i')].map((i) => i.className);
    expect(steps).toEqual(['step-current', 'step-todo']);
    expect(within(c).getByRole('img', { name: /^4 agents: Main session, fable-lead, sonnet-engineer, verifier$/ })).toBeTruthy();
    expect(c.querySelector('.rcfoot').textContent).toContain('4 agents · $1.86 · 12m');
  });

  it('a needs-you card shows the question and one button per action; a quick answer posts respond(id, label, "") then onDone', async () => {
    let release;
    post = vi.fn(() => new Promise((r) => (release = () => r({ ok: true, status: 200, json: () => Promise.resolve({}) }))));
    const { onDone } = mount({ waiting: [waitingRun('w1', 10)], active: [], finished: [] });
    const c = card('w1');
    expect(c.querySelector('.ask').textContent).toBe('Accept, push and open the PR?');
    const answers = [...c.querySelectorAll('.rc-actions button')];
    expect(answers.map((b) => b.textContent)).toEqual(['Accept', 'Request changes', 'Stop run']);
    fireEvent.click(within(c).getByRole('button', { name: 'Request changes' }));
    expect(post).toHaveBeenCalledWith('/api/runs/w1/respond', { action: 'Request changes', text: '' });
    for (const b of answers) expect(b.disabled).toBe(true);
    expect(strip()).toBeNull(); // answering does not open the crew strip
    await act(async () => release());
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(answers.every((b) => !b.disabled)).toBe(true));
  });

  it('a quick answer that ends the run (ends: true) asks to confirm first; Cancel sends nothing, Confirm sends; other answers stay one click', async () => {
    const run = waitingRun('w1', 10, { actions: [{ label: 'Accept' }, { label: 'Request changes' }, { label: 'Stop run', ends: true }] });
    const { onDone } = mount({ waiting: [run], active: [], finished: [] });
    const c = card('w1');
    const stop = within(c).getByRole('button', { name: 'Stop run' });
    expect(stop.classList.contains('danger')).toBe(true);
    expect(within(c).getByRole('button', { name: 'Accept' }).classList.contains('danger')).toBe(false);
    fireEvent.click(stop);
    expect(post).not.toHaveBeenCalled();
    const group = within(c).getByRole('group', { name: 'Confirm stop' });
    expect(group.textContent).toContain("Stop the run? This can't be undone.");
    expect(within(c).queryByRole('button', { name: 'Accept' })).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    expect(post).not.toHaveBeenCalled();
    expect(within(c).getByRole('button', { name: 'Accept' })).toBeTruthy();
    fireEvent.click(within(c).getByRole('button', { name: 'Stop run' }));
    fireEvent.click(within(within(c).getByRole('group', { name: 'Confirm stop' })).getByRole('button', { name: 'Confirm' }));
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/runs/w1/respond', { action: 'Stop run', text: '' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    fireEvent.click(within(c).getByRole('button', { name: 'Request changes' })); // not an ending answer: one click
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('the end-confirm takes focus on Cancel and Cancel hands it back to the answer button', async () => {
    const run = waitingRun('w1', 10, { actions: [{ label: 'Accept' }, { label: 'Stop run', ends: true }] });
    mount({ waiting: [run], active: [], finished: [] });
    const c = card('w1');
    fireEvent.click(within(c).getByRole('button', { name: 'Stop run' }));
    const group = within(c).getByRole('group', { name: 'Confirm stop' });
    expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    await Promise.resolve();
    expect(document.activeElement).toBe(within(c).getByRole('button', { name: 'Stop run' }));
  });

  it('a click in the answers area (the end-confirm text, the quick answers) does not toggle the crew strip', () => {
    const run = waitingRun('w1', 10, { actions: [{ label: 'Accept' }, { label: 'Stop run', ends: true }] });
    mount({ waiting: [run], active: [], finished: [] });
    const c = card('w1');
    fireEvent.click(within(c).getByRole('button', { name: 'Stop run' }));
    const group = within(c).getByRole('group', { name: 'Confirm stop' });
    fireEvent.click(within(group).getByText("Stop the run? This can't be undone."));
    fireEvent.click(group.parentElement); // the empty space of the answers row
    expect(strip()).toBeNull();
    fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(c.querySelector('.rc-actions'));
    expect(strip()).toBeNull();
    fireEvent.click(c.querySelector('.rc-top')); // elsewhere on the card still toggles
    expect(strip()).toBeTruthy();
  });

  it('a failed quick answer shows the error inline and re-enables the buttons', async () => {
    post = vi.fn(() => res({ error: 'Run is not waiting.' }, false));
    const { onDone } = mount({ waiting: [waitingRun('w1', 10)], active: [], finished: [] });
    fireEvent.click(within(card('w1')).getByRole('button', { name: 'Accept' }));
    expect((await within(card('w1')).findByRole('alert')).textContent).toBe('Run is not waiting.');
    expect(within(card('w1')).getByRole('button', { name: 'Accept' }).disabled).toBe(false);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('the crew strip: toggled by the card (click or Enter), placed right after it, one open at a time, Escape closes and returns focus', async () => {
    mount({ waiting: [waitingRun('w1', 10)], active: [activeRun('a1'), activeRun('a2')], finished: [] });
    expect(toggleOf('a1').getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(card('a1').querySelector('.rc-stage'));
    expect(toggleOf('a1').getAttribute('aria-expanded')).toBe('true');
    expect(card('a1').nextElementSibling).toBe(strip());
    expect(strip().getAttribute('aria-label')).toBe('Crew of a1');
    expect(toggleOf('a1').getAttribute('aria-controls')).toBe(strip().id);
    expect(within(strip()).getByRole('link', { name: 'Open run →' }).getAttribute('href')).toBe('#/runs/a1/crew');
    await waitFor(() => expect(strip().querySelectorAll('[data-agent-id]')).toHaveLength(4));
    const ver = strip().querySelector('[data-agent-id="a-ver"]');
    expect(ver.textContent).toContain('verifier');
    expect(ver.textContent).toContain('Running');
    expect(ver.textContent).toContain('Bash npx vitest run');
    expect(ver.textContent).toContain('Sonnet 5.5 · $0.31');
    const old = strip().querySelector('[data-agent-id="a-old"]');
    expect(old.textContent).toContain('Done');
    expect(old.textContent).toContain('Build the first piece');
    expect(old.textContent).toContain('Sonnet 5.5 · –'); // zero tokens: usage not read yet, so no $0.00

    fireEvent.keyDown(toggleOf('a2'), { key: 'Enter' });
    expect(toggleOf('a2').getAttribute('aria-expanded')).toBe('true');
    expect(toggleOf('a1').getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelectorAll('section[aria-label^="Crew of "]')).toHaveLength(1);
    expect(card('a2').nextElementSibling).toBe(strip());

    toggleOf('a2').focus();
    fireEvent.keyDown(document.activeElement, { key: 'Escape' });
    expect(strip()).toBeNull();
    expect(toggleOf('a2').getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toggleOf('a2'));

    fireEvent.click(toggleOf('w1'));
    expect(strip().getAttribute('aria-label')).toBe('Crew of w1');
    fireEvent.click(toggleOf('w1'));
    expect(strip()).toBeNull();
  });

  it('search never hides waiting cards (like the inbox); views show only their own cards; running cards follow search', () => {
    const g = { waiting: [waitingRun('w1', 10)], active: [activeRun('a1'), activeRun('zz9', { title: 'Other job' })], finished: [] };
    const { again } = mount(g, { query: 'other' });
    const ids = () => [...document.querySelectorAll('article[data-run-id]')].map((a) => a.getAttribute('data-run-id'));
    expect(ids()).toEqual(['w1', 'zz9']);
    again(g, { query: '', view: 'waiting' });
    expect(ids()).toEqual(['w1']);
    again(g, { query: '', view: 'active' });
    expect(ids()).toEqual(['a1', 'zz9']);
    again({ waiting: [], active: [], finished: [] }, { query: '', view: null });
    expect(screen.getByText('No runs yet.')).toBeTruthy();
  });

  it('the header sums up the live runs and today\'s spend', async () => {
    mount({ waiting: [waitingRun('w1', 10)], active: [activeRun('a1'), activeRun('a2')], finished: [] });
    const head = document.querySelector('header.page-head');
    expect(head.textContent).toContain('3 live runs');
    expect(head.textContent).toContain('2 running');
    expect(head.textContent).toContain('1 need you');
    await waitFor(() => expect(head.textContent).toContain('$18.40 today'));
  });
});

describe('List rows and KPI cards', () => {
  it('KPI subs: agents working, oldest waiting, API-equivalent estimate, cache-read share', async () => {
    mount({ waiting: [waitingRun('w1', 120)], active: [activeRun('a1')], finished: [] });
    const tile = (label) => [...document.querySelectorAll('section.stat-strip .stat')].find((s) => s.querySelector('.stat-label').textContent === label);
    await waitFor(() => expect(tile('Running').querySelector('.stat-sub').textContent).toBe('6 agents working'));
    expect(tile('Needs you')).toBeUndefined(); // the inbox carries the count and the oldest wait (needs-you-count-x4)
    expect(document.querySelector('.inbox-note').textContent).toMatch(/^Oldest waiting 2h ago\./);
    await waitFor(() => expect(tile('Spend today').querySelector('.stat-value').textContent).toBe('$18.40'));
    expect(tile('Spend today').querySelector('.stat-sub').textContent).toBe('API-equivalent estimate');
    expect(tile('Tokens today').querySelector('.stat-value').textContent).toBe('41.2M');
    expect(tile('Tokens today').querySelector('.stat-sub').textContent).toBe('86% cache reads');
  });

  it('a running row shows the working pill, avatars, cost and run time once the detail is in', async () => {
    mount({ waiting: [], active: [activeRun('a1')], finished: [] });
    const row = screen.getByRole('link', { name: /Busy a1/ });
    await waitFor(() => expect(row.querySelector('.working').textContent).toBe('verifier · Bash npx vitest run'));
    expect(row.querySelector('.run-cost').textContent).toBe('$1.86');
    expect(row.querySelector('.run-age').textContent).toBe('12m');
    expect(within(row).getByRole('img', { name: /^4 agents:/ })).toBeTruthy();
  });
});
