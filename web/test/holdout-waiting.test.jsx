// Holdout: WaitingCard rendering, route, splitRuns, App sidebar + Monitor decision inbox (AC1, AC2, AC4, AC5).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { WaitingCard } from '../src/WaitingCards.jsx';
import { parseRoute } from '../src/lib/route.js';
import { splitRuns } from '../src/lib/format.js';

const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting', verdict: null,
  ask: "What's your solution?", actions: [{ label: 'Agree spec' }, { label: 'Stop run' }], textField: true, updatedAt: new Date().toISOString(), ...over,
});
const LONG = '[CloudLab] T10.10 template requests: a new table?\nBackground: lives in `requests` table.\nProposal: a new table.\nOptions: A = new / B = type\nAnswer: Resume with A or B.';

describe('route and splitRuns', () => {
  it('#/waiting has no page of its own (lands on the Monitor); others unchanged', () => {
    expect(parseRoute('#/waiting')).toEqual({ name: 'monitor' });
    expect(parseRoute('#/workflow')).toEqual({ name: 'workflow' });
    expect(parseRoute('#/runs/a%20b')).toEqual({ name: 'run', id: 'a b' });
    expect(parseRoute('#/waiting/x').name).toBe('monitor');
    expect(parseRoute('').name).toBe('monitor');
  });
  it('live excludes waiting runs; waiting and finished keep their members', () => {
    const r = splitRuns([mk('w'), { id: 'a', status: 'active' }, { id: 'd', status: 'done' }, { id: 's', status: 'stopped' }]);
    expect(r.waiting.map((x) => x.id)).toEqual(['w']);
    expect(r.live.map((x) => x.id)).toEqual(['a']);
    expect(r.finished.map((x) => x.id)).toEqual(['d', 's']);
    expect(splitRuns(null)).toEqual({ waiting: [], live: [], finished: [] });
  });
});

describe('WaitingCard ask rendering', () => {
  beforeEach(() => { globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) })); });
  afterEach(() => vi.restoreAllMocks());

  it('long ask: heading h4, labelled rows with label and text spans, inline code element', () => {
    const { container } = render(<WaitingCard run={mk('a', { ask: LONG })} />);
    const ask = container.querySelector('.ask');
    expect(ask).toBeTruthy();
    const h = ask.querySelector('h4.ask-heading');
    expect(h.textContent).toBe('[CloudLab] T10.10 template requests: a new table?');
    const rows = [...ask.querySelectorAll('.ask-row')];
    expect(rows.map((r) => r.querySelector('.ask-label').textContent)).toEqual(['Background', 'Proposal', 'Options', 'Answer']);
    expect(rows[0].querySelector('.ask-text').textContent).toBe('lives in requests table.');
    expect(rows[0].querySelector('code').textContent).toBe('requests');
    expect(ask.textContent).not.toContain('`');
  });
  it('one-line ask: heading only, no rows or paragraphs', () => {
    const { container } = render(<WaitingCard run={mk('a')} />);
    expect(container.querySelector('.ask h4.ask-heading').textContent).toBe("What's your solution?");
    expect(container.querySelectorAll('.ask-row, .ask-para').length).toBe(0);
    expect(screen.getByText("What's your solution?")).toBeTruthy();
  });
  it('plain extra lines render as .ask-para', () => {
    const { container } = render(<WaitingCard run={mk('a', { ask: 'Head\nsome plain\nmore' })} />);
    expect(container.querySelector('p.ask-para').textContent).toBe('some plain\nmore');
  });
  it('missing or empty ask renders no empty heading, and the buttons still work', () => {
    for (const ask of [null, undefined, '', '  ']) {
      const { container, unmount } = render(<WaitingCard run={mk('a', { ask })} />);
      expect(container.querySelector('h4.ask-heading')).toBeNull();
      expect(container.querySelector('.ask-row')).toBeNull();
      expect(screen.getByRole('button', { name: 'Agree spec' })).toBeTruthy();
      unmount();
    }
  });
  it('HTML-like text is rendered as text, never as elements', () => {
    const { container } = render(<WaitingCard run={mk('a', { ask: '<img src=x onerror=alert(1)> <b>bold</b>\nNote: <script>x</script> `<i>c</i>`' })} />);
    const ask = container.querySelector('.ask');
    expect(ask.querySelector('img, script, b, i')).toBeNull();
    expect(ask.textContent).toContain('<img src=x onerror=alert(1)> <b>bold</b>');
    expect(ask.querySelector('code').textContent).toBe('<i>c</i>');
  });
  it('card keeps its aria-label, textarea and responds with the typed text', async () => {
    const onDone = vi.fn();
    render(<WaitingCard run={mk('a', { ask: LONG })} onDone={onDone} />);
    const card = screen.getByRole('article', { name: 'Waiting on you: Run a' });
    fireEvent.change(within(card).getByRole('textbox'), { target: { value: 'ok' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Stop run' }));
    await waitFor(() => expect(onDone).toHaveBeenCalled());
    expect(JSON.parse(globalThis.fetch.mock.calls[0][1].body)).toEqual({ action: 'Stop run', text: 'ok' });
  });
});

describe('App: Monitor groups and decision inbox', () => {
  let runs;
  let sources;
  beforeEach(() => {
    runs = [mk('w1', { ask: LONG }), mk('w2'), { ...mk('act'), status: 'active', ask: null, actions: [], title: 'Busy run' }, { ...mk('fin'), status: 'done', ask: null, title: 'Done run' }];
    sources = [];
    globalThis.EventSource = class { constructor() { sources.push(this); } close() {} };
    globalThis.fetch = vi.fn((url, opts = {}) => {
      const j = (b) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(b) });
      if (opts.method === 'POST') {
        const id = /runs\/([^/]+)\/respond/.exec(url)?.[1];
        runs = runs.map((r) => (r.id === id ? { ...r, status: 'active', ask: null, actions: [] } : r));
        return j({});
      }
      if (url === '/api/runs') return j(runs);
      return j({});
    });
    window.location.hash = '#/';
  });
  afterEach(() => { window.location.hash = ''; vi.restoreAllMocks(); });

  const nav = () => within(screen.getByRole('navigation', { name: 'Sections' }));
  const views = () => within(screen.getByRole('navigation', { name: 'Views' }));
  const pane = () => within(screen.getByRole('complementary', { name: 'Decision inbox' }));

  it('nav has Monitor, Workflow, Stats (no Waiting); Monitor carries the open count and aria-current', async () => {
    render(<App />);
    await waitFor(() => expect(nav().getByRole('link', { name: /^Monitor/ }).textContent).toBe('Monitor3'));
    expect(nav().getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#/', '#/workflow', '#/stats']);
    expect(nav().queryByRole('link', { name: /Waiting/ })).toBeNull();
    expect(nav().getByRole('link', { name: /^Monitor/ }).getAttribute('aria-current')).toBe('page');
  });
  it('Views show the Waiting on you count; #/waiting lands on the Monitor', async () => {
    window.location.hash = '#/waiting';
    render(<App />);
    await waitFor(() => expect(views().getByRole('button', { name: /^Waiting on you/ }).textContent).toBe('Waiting on you2'));
    expect(views().getByRole('button', { name: /^Active/ }).textContent).toBe('Active1');
    expect(views().getByRole('button', { name: /^Finished/ }).textContent).toBe('Finished1');
    expect(nav().getByRole('link', { name: /^Monitor/ }).getAttribute('aria-current')).toBe('page');
    expect(screen.getByRole('heading', { level: 1, name: 'Monitor' })).toBeTruthy();
  });
  it('Monitor lists Active and Finished (no Waiting on you group); the inbox holds one item per waiting run, the first open', async () => {
    render(<App />);
    await screen.findByRole('article', { name: 'Waiting on you: Run w2' });
    expect(document.querySelector('section[aria-labelledby="group-waiting"]')).toBeNull();
    expect(pane().getByRole('heading', { level: 2 }).textContent).toBe('2 need your input');
    expect(screen.getByText('Busy run')).toBeTruthy();
    expect(document.querySelector('section[aria-labelledby="group-active"]')).toBeTruthy();
    expect(document.querySelector('section[aria-labelledby="group-finished"] details.finished')).toBeTruthy();
    expect(screen.getAllByRole('article').length).toBe(2);
    expect(pane().getAllByRole('article').length).toBe(2);
    expect(pane().getAllByRole('link', { name: 'Open run →' }).map((a) => a.getAttribute('href'))).toEqual(['#/runs/w1', '#/runs/w2']);
    expect(within(pane().getByRole('article', { name: 'Waiting on you: Run w1' })).getByRole('heading', { level: 3 })).toBeTruthy();
    expect(within(pane().getByRole('article', { name: 'Waiting on you: Run w2' })).queryByRole('heading', { level: 3 })).toBeNull();
    expect(document.querySelector('table')).toBeNull();
  });
  it('opening a folded item shows its ask and Open run link', async () => {
    render(<App />);
    const w2 = await screen.findByRole('article', { name: 'Waiting on you: Run w2' });
    expect(w2.querySelector('.ui-dic__body').hasAttribute('inert')).toBe(true);
    fireEvent.click(within(w2).getByRole('button', { name: 'Run w2' }));
    expect(within(w2).getByRole('heading', { level: 3 }).textContent).toBe('Run w2');
    expect(w2.querySelector('.ui-dic__body').hasAttribute('inert')).toBe(false);
    expect(within(w2).getByText("What's your solution?")).toBeTruthy();
    expect(within(w2).getByRole('link', { name: 'Open run →' }).getAttribute('href')).toBe('#/runs/w2');
  });
  it('no waiting run: no group, count 0, and the empty pane says Nothing is waiting on you.', async () => {
    runs = [{ ...mk('act'), status: 'active' }];
    render(<App />);
    await screen.findByText('Run act');
    expect(views().getByRole('button', { name: /^Waiting on you/ }).textContent).toBe('Waiting on you0');
    expect(document.querySelector('section[aria-labelledby="group-waiting"]')).toBeNull();
    expect(pane().getByText('Nothing is waiting on you.')).toBeTruthy();
    expect(screen.queryByRole('article')).toBeNull();
  });
  it('answering confirms, then folds the item away; the count follows an event-stream refresh', async () => {
    render(<App />);
    await screen.findByRole('article', { name: 'Waiting on you: Run w1' });
    fireEvent.click(screen.getByRole('button', { name: 'Run w2' }));
    const card = screen.getByRole('article', { name: 'Waiting on you: Run w2' });
    fireEvent.click(within(card).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(card.querySelector('.ui-dic__done[role=status]').textContent).toBe('Agree spec'));
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(1), { timeout: 3000 });
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w1' })).toBeTruthy();
    expect(screen.queryByRole('article', { name: 'Waiting on you: Run w2' })).toBeNull();
    expect(views().getByRole('button', { name: /^Waiting on you/ }).textContent).toBe('Waiting on you1');
    runs = runs.map((r) => (r.id === 'w1' ? { ...r, status: 'active' } : r));
    await act(async () => { sources.at(-1).onmessage?.({}); await new Promise((r) => setTimeout(r, 400)); });
    await waitFor(() => expect(views().getByRole('button', { name: /^Waiting on you/ }).textContent).toBe('Waiting on you0'));
    expect(pane().getByText('Nothing is waiting on you.')).toBeTruthy();
  });
  it('the inbox uses the unfiltered waiting list (search does not empty it)', async () => {
    render(<App />);
    await screen.findByRole('article', { name: 'Waiting on you: Run w1' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Search runs' }), { target: { value: 'busy' } });
    expect(screen.getByText('Busy run')).toBeTruthy();
    expect(within(screen.getByRole('region', { name: 'Runs' })).queryByText('Done run')).toBeNull();
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w1' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Waiting on you: Run w2' })).toBeTruthy();
  });
  it('load error shows on the Monitor', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<App />);
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));
  });
});
