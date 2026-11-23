import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPage } from '../src/accounts/AccountsPage.jsx';

const NOW = Date.now();
const MIN = 60_000;
const H = 60 * MIN;
const iso = (ms) => new Date(ms).toISOString();
const SIGN_URL = 'https://claude.com/cai/oauth/authorize?code=true&state=stubstate';
const acc = (o = {}) => ({
  name: 'a', email: null, active: false, saved: true, status: 'no-reading', fiveHour: null, sevenDay: null, fiveHourResetsAt: null,
  sevenDayResetsAt: null, left: null, limitedUntil: null, refreshExpiresAt: iso(NOW + 30 * 24 * H), readingAt: null, ...o,
});
const ryan = () => acc({
  name: 'ryan', email: 'ryan@example.com', active: true, status: 'available', fiveHour: 40, sevenDay: 20, fiveHourResetsAt: NOW + 3 * H,
  sevenDayResetsAt: NOW + 72 * H, left: 60, readingAt: iso(NOW - 10 * MIN),
});
const lab = () => acc({
  name: 'lab', email: 'lab@example.com', status: 'limited', fiveHour: 100, sevenDay: 30, fiveHourResetsAt: NOW + 2 * H,
  sevenDayResetsAt: NOW + 50 * H, left: 0, limitedUntil: NOW + 2 * H, readingAt: iso(NOW - 5 * MIN),
});
const orders = () => acc({ name: 'orders', email: 'orders@example.com' });
const gone = () => acc({ name: 'gone', saved: false, status: 'no-login', refreshExpiresAt: null });
const base = (o = {}) => ({ enabled: true, accounts: [ryan(), lab(), orders(), gone()], liveReason: null, liveRuns: 0, refresh: null, signIn: null, ...o });

let server;
let calls;
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
beforeEach(() => {
  calls = [];
  server = { state: base(), post: {} };
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const method = opts.method ?? 'GET';
    calls.push({ url, method, headers: opts.headers, body: opts.body === undefined ? undefined : JSON.parse(opts.body) });
    if (method === 'GET') return reply(200, JSON.parse(JSON.stringify(server.state)));
    const h = server.post[url];
    if (!h) return reply(404, { error: 'Not found.' });
    const r = h(JSON.parse(opts.body));
    return r && typeof r.then === 'function' ? r : reply(...r);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const gets = () => calls.filter((c) => c.method === 'GET' && c.url === '/api/accounts').length;
const posts = (p) => calls.filter((c) => c.method === 'POST' && c.url === p);
const card = (name) => document.querySelector(`article[data-account="${name}"]`);
const sleep = (ms) => act(() => new Promise((r) => setTimeout(r, ms)));
async function open(props = {}) {
  const view = render(<AccountsPage tick={0} pollMs={20} {...props} />);
  await waitFor(() => expect(card('ryan') ?? screen.queryByText(/read-only/)).toBeTruthy());
  return view;
}

describe('Accounts page', () => {
  it('one card per account: name, email, Active pill, status words, bars only with a reading, facts', async () => {
    await open();
    expect(screen.getByRole('heading', { level: 1, name: 'Accounts' })).toBeTruthy();
    expect(document.querySelectorAll('article[data-account]')).toHaveLength(4);

    const r = within(card('ryan'));
    expect(r.getByText('ryan@example.com')).toBeTruthy();
    expect(r.getByText('Active')).toBeTruthy();
    expect(r.getByText('Available')).toBeTruthy();
    expect(r.getByRole('progressbar', { name: '5-hour usage' }).getAttribute('aria-valuenow')).toBe('40');
    expect(r.getByRole('progressbar', { name: '7-day usage' }).getAttribute('aria-valuenow')).toBe('20');
    expect(r.getByText('60% left')).toBeTruthy();
    expect(r.getByText('Updated 10m ago')).toBeTruthy();
    expect(r.getByText(/^resets in 2h 59m|^resets in 3h 00m/)).toBeTruthy();
    expect(r.getByText(/^Refresh by /)).toBeTruthy();
    expect(r.queryByRole('button', { name: 'Switch to this account' })).toBeNull();

    const o = within(card('orders'));
    expect(o.queryAllByRole('progressbar')).toHaveLength(0);
    expect(o.getAllByText('No usage reading yet').length).toBeGreaterThan(0);
    expect(o.queryByText('Active')).toBeNull();
    expect(within(card('lab')).getByText(/^Limited until \S/)).toBeTruthy();
    expect(within(card('gone')).getByText('No saved login')).toBeTruthy();
  });

  it('switch: one click, one JSON POST, progress while it runs, then a refetch and a note', async () => {
    let resolve;
    server.post['/api/accounts/use'] = () => new Promise((r) => { resolve = r; });
    const confirm = vi.spyOn(window, 'confirm');
    await open();
    const before = gets();
    const btn = within(card('orders')).getByRole('button', { name: 'Switch to this account' });
    fireEvent.click(btn);
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute('aria-busy')).toBe('true');
    expect(within(card('orders')).getByText('Switching…')).toBeTruthy();
    fireEvent.click(btn);
    expect(posts('/api/accounts/use')).toHaveLength(1);
    const [c] = posts('/api/accounts/use');
    expect(c.body).toEqual({ name: 'orders' });
    expect(c.headers['Content-Type']).toBe('application/json');
    expect(confirm).not.toHaveBeenCalled();

    server.state = base({ accounts: [{ ...ryan(), active: false }, lab(), { ...orders(), active: true }, gone()] });
    await act(async () => resolve(await reply(200, { from: 'ryan', to: 'orders', switched: true })));
    await waitFor(() => expect(gets()).toBeGreaterThan(before));
    await waitFor(() => expect(within(card('orders')).getByText('Active')).toBeTruthy());
    expect(screen.getByText('Switched to "orders".')).toBeTruthy();
    expect(within(card('ryan')).getByRole('button', { name: 'Switch to this account' }).disabled).toBe(false);
  });

  it('switch disabled with the reason shown: no saved login, limited, expired login', async () => {
    server.state = base({ accounts: [ryan(), lab(), gone(), acc({ name: 'stale', status: 'available', readingAt: iso(NOW - MIN), refreshExpiresAt: iso(NOW - 24 * H) })] });
    await open();
    const why = (name) => {
      const b = within(card(name)).getByRole('button', { name: 'Switch to this account' });
      expect(b.disabled).toBe(true);
      return document.getElementById(b.getAttribute('aria-describedby')).textContent;
    };
    expect(why('gone')).toMatch(/No saved login/);
    expect(why('lab')).toMatch(/^Out of usage until \S/);
    expect(why('stale')).toMatch(/login expired on .+add this account again/);
    expect(within(card('stale')).getByText('Login needs re-adding')).toBeTruthy();
  });

  it('a failed switch shows the server error in that card', async () => {
    server.post['/api/accounts/use'] = () => [400, { error: 'no saved login for "orders"; run: agent-monitor accounts add orders' }];
    await open();
    fireEvent.click(within(card('orders')).getByRole('button', { name: 'Switch to this account' }));
    expect((await within(card('orders')).findByRole('alert')).textContent).toMatch(/no saved login for "orders"/);
    expect(screen.queryByText(/Switched to/)).toBeNull();
  });

  it('live runs: switchable cards say open chats may need "continue"; none without live runs', async () => {
    server.state = base({ liveRuns: 2 });
    const v = await open();
    const note = within(card('orders')).getByText(/open chats may need "continue"/);
    expect(note.textContent).toMatch(/^2 runs are working/);
    expect(within(card('orders')).getByRole('button', { name: 'Switch to this account' }).getAttribute('aria-describedby')).toBe(note.id);
    expect(within(card('ryan')).queryByText(/continue/)).toBeNull();
    v.unmount();
    server.state = base({ liveRuns: 0 });
    await open();
    expect(screen.queryByText(/continue/)).toBeNull();
  });

  it('accounts off: a read-only notice and no action buttons', async () => {
    server.state = { enabled: false, accounts: [], liveReason: null, liveRuns: 1, refresh: null, signIn: null };
    await open();
    expect(screen.getByText(/turned off on this machine.*read-only/)).toBeTruthy();
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    await sleep(60);
    expect(posts('/api/accounts/refresh')).toHaveLength(0);
  });

  it('server text is rendered as text', async () => {
    server.state = base({ accounts: [acc({ name: 'x', email: '<img src=x onerror="window.pwned=1">' })], liveReason: '<b>odd</b> login' });
    render(<AccountsPage tick={0} pollMs={20} />);
    expect(await screen.findByText('<img src=x onerror="window.pwned=1">')).toBeTruthy();
    expect(screen.getByText(/<b>odd<\/b> login/)).toBeTruthy();
    expect(document.querySelector('article img, article b, .acct-notice b')).toBeNull();
  });

  it('auto refresh: once on open when a reading is older than 30 minutes, then never again on later ticks', async () => {
    server.state = base({ accounts: [{ ...ryan(), readingAt: iso(NOW - 45 * MIN) }, orders()] });
    server.post['/api/accounts/refresh'] = () => {
      server.state = { ...server.state, refresh: { running: false, at: iso(Date.now()), results: [{ name: 'ryan', ok: true, error: null }] } };
      return [202, { refresh: { running: true, at: iso(Date.now()), results: [] } }];
    };
    const v = await open();
    await waitFor(() => expect(posts('/api/accounts/refresh')).toHaveLength(1));
    expect(posts('/api/accounts/refresh')[0].body).toEqual({});
    v.rerender(<AccountsPage tick={1} pollMs={20} />);
    v.rerender(<AccountsPage tick={2} pollMs={20} />);
    await sleep(80);
    expect(posts('/api/accounts/refresh')).toHaveLength(1);
    expect(await within(card('ryan')).findByText('Usage refreshed.')).toBeTruthy();
  });

  it('auto refresh: not when readings are fresh, and not for missing readings alone', async () => {
    const v = await open();
    await sleep(60);
    expect(posts('/api/accounts/refresh')).toHaveLength(0);
    v.unmount();
    server.state = base({ accounts: [orders(), gone()] });
    render(<AccountsPage tick={0} pollMs={20} />);
    await waitFor(() => expect(card('orders')).toBeTruthy());
    await sleep(60);
    expect(posts('/api/accounts/refresh')).toHaveLength(0);
  });

  it('Refresh usage: disabled while running, per-account results and errors, polling stops when it ends', async () => {
    let polls = 0;
    server.post['/api/accounts/refresh'] = () => {
      server.state = { ...server.state, refresh: { running: true, at: iso(Date.now()), results: [{ name: 'ryan', ok: true, error: null }] } };
      return [202, { refresh: { running: true, at: iso(Date.now()), results: [] } }];
    };
    await open();
    const btn = screen.getByRole('button', { name: 'Refresh usage' });
    fireEvent.click(btn);
    await waitFor(() => expect(btn.disabled).toBe(true));
    expect(posts('/api/accounts/refresh')).toHaveLength(1);
    expect(await within(card('ryan')).findByText('Usage refreshed.')).toBeTruthy();
    expect(within(card('orders')).getByText(/Refreshing…/)).toBeTruthy();
    // the job ends after a few polls
    const done = { running: false, at: iso(Date.now()), results: [{ name: 'ryan', ok: true, error: null }, { name: 'lab', ok: false, error: 'Claude Code returned no usage reading (exit 1)' }, { name: 'orders', ok: true, error: null }] };
    globalThis.fetch.mockImplementation((url, opts = {}) => {
      const method = opts.method ?? 'GET';
      calls.push({ url, method });
      if (method === 'GET' && ++polls >= 3) server.state = { ...server.state, refresh: done };
      return reply(200, JSON.parse(JSON.stringify(server.state)));
    });
    await waitFor(() => expect(btn.disabled).toBe(false), { timeout: 2000 });
    expect(within(card('lab')).getByText('Refresh failed: Claude Code returned no usage reading (exit 1)')).toBeTruthy();
    expect(within(card('orders')).getByText('Usage refreshed.')).toBeTruthy();
    const n = gets();
    await sleep(120);
    expect(gets()).toBe(n);
  });

  it('polling stops on unmount', async () => {
    server.state = base({ refresh: { running: true, at: iso(NOW), results: [] } });
    const v = await open();
    await waitFor(() => expect(gets()).toBeGreaterThan(2));
    v.unmount();
    const n = gets();
    await sleep(120);
    expect(gets()).toBe(n);
    expect(posts('/api/accounts/refresh')).toHaveLength(0); // a refresh already running is followed, not started again
  });

  it('add account: name check, sign-in link, code box, checking, done', async () => {
    server.post['/api/accounts/add'] = (b) => {
      server.state = { ...server.state, signIn: { state: 'waiting', name: b.name, url: SIGN_URL, needsCode: true, error: null, startedAt: iso(NOW) } };
      return [202, { signIn: { state: 'starting', name: b.name, url: null, needsCode: false, error: null, startedAt: iso(NOW) } }];
    };
    server.post['/api/accounts/add/code'] = () => {
      server.state = { ...server.state, signIn: { ...server.state.signIn, state: 'checking', needsCode: false } };
      return [200, { signIn: server.state.signIn }];
    };
    await open();
    const addBtn = screen.getByRole('button', { name: 'Add account' });
    expect(addBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(addBtn);
    expect(addBtn.getAttribute('aria-expanded')).toBe('true');
    const name = screen.getByLabelText('Name');
    await waitFor(() => expect(document.activeElement).toBe(name));

    fireEvent.change(name, { target: { value: 'Bad Name' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    expect(name.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(/Give a name of 1-32 characters/)).toBeTruthy();
    expect(posts('/api/accounts/add')).toHaveLength(0);

    fireEvent.change(name, { target: { value: 'newbie' } });
    fireEvent.change(screen.getByLabelText('Email (optional)'), { target: { value: 'new@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    const link = await screen.findByRole('link', { name: 'Open the sign-in page' });
    expect(posts('/api/accounts/add')[0].body).toEqual({ name: 'newbie', email: 'new@example.com' });
    expect(link.getAttribute('href')).toBe(SIGN_URL);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(screen.getByRole('button', { name: 'Add account' }).disabled).toBe(true);

    const box = screen.getByLabelText('Paste the code shown after you sign in');
    fireEvent.change(box, { target: { value: '  good#stubstate ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send code' }));
    await waitFor(() => expect(screen.getByText('Checking the code…')).toBeTruthy());
    expect(posts('/api/accounts/add/code')[0].body).toEqual({ code: 'good#stubstate' });
    expect(screen.queryByLabelText('Paste the code shown after you sign in')).toBeNull();

    server.state = { ...server.state, accounts: [...server.state.accounts, acc({ name: 'newbie', email: 'new@example.com' })], signIn: { ...server.state.signIn, state: 'done', url: null } };
    expect(await screen.findByText('Added "newbie".')).toBeTruthy();
    await waitFor(() => expect(card('newbie')).toBeTruthy());
    expect(screen.getByLabelText('Name').value).toBe('');
    const n = gets();
    await sleep(100);
    expect(gets()).toBe(n); // the poll stopped with the sign-in
  });

  it('add account: a rejected code is shown, Cancel cancels, a hostile link is never rendered', async () => {
    server.state = base({ signIn: { state: 'waiting', name: 'newbie', url: 'javascript:alert(1)', needsCode: true, error: 'That code was not accepted. Copy the whole code from the sign-in page and paste it again.', startedAt: iso(NOW) } });
    server.post['/api/accounts/add/cancel'] = () => {
      server.state = { ...server.state, signIn: { ...server.state.signIn, state: 'cancelled', url: null, needsCode: false, error: null } };
      return [200, { signIn: server.state.signIn }];
    };
    await open();
    expect(screen.getByText(/Signing in as/).textContent).toMatch(/newbie/);
    expect(screen.queryByRole('link')).toBeNull();
    const box = screen.getByLabelText('Paste the code shown after you sign in');
    expect(box.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/not accepted/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(posts('/api/accounts/add/cancel')).toHaveLength(1));
    // a sign-in started elsewhere: when it ends the panel goes away with it
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Cancel' })).toBeNull());
    expect(screen.queryByLabelText('Paste the code shown after you sign in')).toBeNull();
  });

  it('add account: the cancelled and failed endings of our own sign-in are reported', async () => {
    server.post['/api/accounts/add'] = (b) => {
      server.state = { ...server.state, signIn: { state: 'waiting', name: b.name, url: SIGN_URL, needsCode: false, error: null, startedAt: iso(NOW) } };
      return [202, { signIn: { state: 'starting', name: b.name, url: null, needsCode: false, error: null, startedAt: iso(NOW) } }];
    };
    server.post['/api/accounts/add/cancel'] = () => {
      server.state = { ...server.state, signIn: { ...server.state.signIn, state: 'cancelled', url: null } };
      return [200, { signIn: server.state.signIn }];
    };
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'newbie' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    expect(await screen.findByText(/This page updates when you are done/)).toBeTruthy();
    expect(screen.queryByLabelText('Paste the code shown after you sign in')).toBeNull();
    expect(posts('/api/accounts/add')[0].body).toEqual({ name: 'newbie' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Sign-in cancelled. Nothing was saved.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Start sign-in' })).toBeTruthy();

    server.post['/api/accounts/add'] = (b) => {
      server.state = { ...server.state, signIn: { state: 'failed', name: b.name, url: null, needsCode: false, error: 'that login is already saved as "lab"', startedAt: iso(NOW + 1) } };
      return [202, { signIn: { state: 'starting', name: b.name, url: null, needsCode: false, error: null, startedAt: iso(NOW + 1) } }];
    };
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    expect(await screen.findByText('Sign-in failed: that login is already saved as "lab". Nothing was saved.')).toBeTruthy();
  });

  it('add account: a refused start shows the server error in the panel', async () => {
    server.post['/api/accounts/add'] = () => [409, { error: 'A sign-in is already running; finish or cancel it first.' }];
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'newbie' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start sign-in' }));
    expect((await screen.findByRole('alert')).textContent).toMatch(/already running/);
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByLabelText('Name')).toBeNull();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add account' }));
  });
});
