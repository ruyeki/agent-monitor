// Holdout: WaitingCard rendering, route, splitRuns, App nav + Waiting page + Monitor (AC1, AC2, AC4, AC5).
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import App from '../src/App.jsx';
import { WaitingCard, WaitingCards } from '../src/WaitingCards.jsx';
import { parseRoute } from '../src/lib/route.js';
import { splitRuns } from '../src/lib/format.js';

const mk = (id, over = {}) => ({
  id, title: `Run ${id}`, stage: 'gate1', stageName: 'Your solution', round: 1, maxRounds: 5, status: 'waiting', verdict: null,
  ask: "What's your solution?", actions: [{ label: 'Agree spec' }, { label: 'Stop run' }], textField: true, updatedAt: new Date().toISOString(), ...over,
});
const LONG = '[CloudLab] T10.10 template requests: a new table?\nBackground: lives in `requests` table.\nProposal: a new table.\nOptions: A = new / B = type\nAnswer: Resume with A or B.';

describe('route and splitRuns', () => {
  it('#/waiting is the waiting route; others unchanged', () => {
    expect(parseRoute('#/waiting')).toEqual({ name: 'waiting' });
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
  it('WaitingCards: count in heading and empty text', () => {
    const { rerender } = render(<WaitingCards runs={[]} />);
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
    rerender(<WaitingCards runs={[mk('a'), mk('b')]} />);
    expect(screen.getByRole('heading', { name: 'Waiting on you (2)' })).toBeTruthy();
    expect(screen.getAllByRole('article').length).toBe(2);
  });
});

describe('App: Waiting tab, Waiting page, Monitor', () => {
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
  const goto = (h) => act(async () => { window.location.hash = h; window.dispatchEvent(new HashChangeEvent('hashchange')); });

  it('nav order, label with count, href, aria-current', async () => {
    render(<App />);
    await waitFor(() => expect(nav().getByRole('link', { name: 'Waiting (2)' })).toBeTruthy());
    expect(nav().getAllByRole('link').map((a) => a.textContent)).toEqual(['Monitor', 'Waiting (2)', 'Workflow', 'Stats']);
    expect(nav().getByRole('link', { name: 'Waiting (2)' }).getAttribute('href')).toBe('#/waiting');
    expect(nav().getByRole('link', { name: 'Monitor' }).getAttribute('aria-current')).toBe('page');
    await goto('#/waiting');
    expect(nav().getByRole('link', { name: 'Waiting (2)' }).getAttribute('aria-current')).toBe('page');
    expect(nav().getByRole('link', { name: 'Monitor' }).getAttribute('aria-current')).toBeNull();
  });
  it('Waiting page shows one card per waiting run and nothing else; no table', async () => {
    render(<App />);
    await goto('#/waiting');
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(2));
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByText('Busy run')).toBeNull();
  });
  it('Monitor has no waiting cards or rows, a link line, caption Active runs', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('link', { name: /2 runs waiting on you/ })).toBeTruthy());
    const link = screen.getByRole('link', { name: /2 runs waiting on you/ });
    expect(link.getAttribute('href')).toBe('#/waiting');
    expect(link.textContent).toBe('2 runs waiting on you →');
    expect(screen.queryByRole('article')).toBeNull();
    expect(screen.queryByText('Run w1')).toBeNull();
    expect(screen.getByText('Busy run')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Runs (1)' })).toBeTruthy();
    expect(document.querySelector('table.runs caption').textContent).toBe('Active runs');
    expect(screen.getByText('Finished runs (1)')).toBeTruthy();
  });
  it('singular link text for one waiting run, no link for none', async () => {
    runs = [mk('w1'), { ...mk('act'), status: 'active' }];
    const { unmount } = render(<App />);
    await waitFor(() => expect(screen.getByRole('link', { name: '1 run waiting on you →' })).toBeTruthy());
    unmount();
    runs = [{ ...mk('act'), status: 'active' }];
    render(<App />);
    await waitFor(() => expect(nav().getByRole('link', { name: 'Waiting (0)' })).toBeTruthy());
    await screen.findByText('Run act');
    expect(screen.queryByRole('link', { name: /waiting on you →/ })).toBeNull();
  });
  it('empty Waiting page says Nothing is waiting on you.', async () => {
    runs = [{ ...mk('act'), status: 'active' }];
    render(<App />);
    await goto('#/waiting');
    await waitFor(() => expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy());
    expect(screen.queryByRole('heading', { name: /^Runs \(/ })).toBeNull();
    expect(nav().getByRole('link', { name: 'Waiting (0)' }).getAttribute('aria-current')).toBe('page');
  });
  it('count updates live after a respond and after an event-stream refresh', async () => {
    render(<App />);
    await goto('#/waiting');
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(2));
    const card = screen.getByRole('article', { name: 'Waiting on you: Run w2' });
    fireEvent.click(within(card).getByRole('button', { name: 'Agree spec' }));
    await waitFor(() => expect(screen.getAllByRole('article').length).toBe(1));
    expect(nav().getByRole('link', { name: 'Waiting (1)' })).toBeTruthy();
    runs = runs.map((r) => (r.id === 'w1' ? { ...r, status: 'active' } : r));
    await act(async () => { sources.at(-1).onmessage?.({}); await new Promise((r) => setTimeout(r, 400)); });
    await waitFor(() => expect(nav().getByRole('link', { name: 'Waiting (0)' })).toBeTruthy());
    expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
  });
  it('load error shows on the Waiting page too', async () => {
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({ error: 'boom' }) }));
    render(<App />);
    await goto('#/waiting');
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('boom'));
  });
});
