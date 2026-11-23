// Holdout (#2289 piece 4, C12): the Accounts page on the whole App. The server is a mock; nothing here can touch a real login.
import { cleanup, configure, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOW, clearStorage, installApi, iso, mountApp } from './holdout-am-affect-pro-helpers.js';

configure({ asyncUtilTimeout: 6000 });
const T = 25000;
const MIN = 60_000;
const GOOD = 'https://claude.ai/oauth/authorize?code=true&client_id=abc';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW); clearStorage(); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); clearStorage(); });

const acct = (name, o = {}) => ({
  name, email: `${name}@example.com`, active: false, saved: true, status: 'available', fiveHour: null, sevenDay: null,
  fiveHourResetsAt: null, sevenDayResetsAt: null, left: 100, limitedUntil: null, refreshExpiresAt: null, readingAt: null, ...o,
});
const reading = (five, seven, ageMin = 5) => ({
  fiveHour: five, sevenDay: seven, fiveHourResetsAt: iso(NOW + 3 * 3600_000), sevenDayResetsAt: iso(NOW + 2 * 86400_000),
  readingAt: iso(NOW - ageMin * MIN), left: 100 - Math.max(five, seven),
});
const world = (over = {}) => ({
  enabled: true,
  accounts: [
    acct('ryan', { active: true, ...reading(10, 20, 5) }),
    acct('lab', { ...reading(40, 60, 5), refreshExpiresAt: iso(NOW + 3 * 86400_000) }),
    acct('orders', { status: 'no-reading' }),
    acct('lim', { status: 'limited', limitedUntil: iso(NOW + 3 * 3600_000), ...reading(100, 30, 5) }),
    acct('ghost', { saved: false, status: 'no-login' }),
  ],
  liveReason: null, liveRuns: 0, refresh: null, signIn: null, ...over,
});

// Mounts the App on `hash` with a stateful mock of /api/accounts. handlers: { 'POST /api/accounts/use': (body, st) => ({status, body}) }.
function setup(state = world(), { hash = '#/accounts', handlers = {} } = {}) {
  installApi({ runs: [] });
  const base = globalThis.fetch;
  const posts = [];
  const gets = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const u = String(url);
    const method = opts.method || 'GET';
    if (!u.startsWith('/api/accounts')) return base(url, opts);
    const body = opts.body ? JSON.parse(opts.body) : undefined;
    if (method === 'GET') gets.push(u); else posts.push({ url: u, method, body, headers: opts.headers });
    const h = handlers[`${method} ${u}`];
    const reply = (r) => Promise.resolve({ ok: (r.status ?? 200) < 400, status: r.status ?? 200, json: () => Promise.resolve(r.body ?? {}) });
    if (h) { const r = h(body, state); return r && typeof r.then === 'function' ? r.then(reply) : reply(r); }
    if (method === 'GET' && u === '/api/accounts') return reply({ body: JSON.parse(JSON.stringify(state)) });
    return reply({ status: method === 'POST' && /\/(refresh|add)$/.test(u) ? 202 : 200, body: {} });
  });
  const view = mountApp(hash);
  return { view, state, posts, gets, postsTo: (suffix) => posts.filter((p) => p.url === `/api/accounts/${suffix}`) };
}
const card = (name) => document.querySelector(`article[data-account="${name}"]`);
const ready = async (name = 'ryan') => { await waitFor(() => expect(card(name)).toBeTruthy()); };
const switchBtn = (name) => within(card(name)).queryByRole('button', { name: 'Switch to this account' });
const settle = (ms = 500) => new Promise((r) => setTimeout(r, ms));
const submit = (el) => {
  const f = el.closest('form');
  if (f) fireEvent.submit(f);
  else fireEvent.click(screen.getAllByRole('button').find((b) => /sign in|start|continue|create|save/i.test(b.textContent)));
};

describe('navigation and header', () => {
  it('the sidebar has an Accounts link after Stats; following it shows the page with its header actions', async () => {
    setup(world(), { hash: '#/' });
    const nav = within(screen.getByRole('navigation', { name: 'Sections' }));
    const links = nav.getAllByRole('link');
    const labels = links.map((l) => l.textContent.trim());
    const at = labels.findIndex((l) => /^Accounts/.test(l));
    expect(at, labels.join(',')).toBeGreaterThan(-1);
    expect(labels.findIndex((l) => /^Stats/.test(l))).toBe(at - 1);
    expect(links[at].getAttribute('href')).toBe('#/accounts');
    fireEvent.click(links[at]);
    if (window.location.hash !== '#/accounts') window.location.hash = '#/accounts';
    await screen.findByRole('heading', { name: 'Accounts' });
    expect(screen.getByRole('button', { name: 'Refresh usage' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Add account' })).toBeTruthy();
    await ready();
    expect(within(screen.getByRole('navigation', { name: 'Sections' })).getByRole('link', { name: /Accounts/ }).getAttribute('aria-current')).toBe('page');
  }, T);
});

describe('cards', () => {
  it('one article per account with name and email; Active only on the live one; the others have a switch button', async () => {
    setup();
    await ready();
    expect([...document.querySelectorAll('article[data-account]')].map((a) => a.getAttribute('data-account')).sort()).toEqual(['ghost', 'lab', 'lim', 'orders', 'ryan']);
    for (const n of ['ryan', 'lab', 'orders', 'lim', 'ghost']) {
      expect(card(n).textContent).toContain(n);
      expect(card(n).textContent).toContain(`${n}@example.com`);
    }
    expect(within(card('ryan')).getByText('Active')).toBeTruthy();
    for (const n of ['lab', 'orders', 'lim', 'ghost']) expect(within(card(n)).queryByText('Active'), n).toBeNull();
    expect(switchBtn('ryan')).toBeNull();
    for (const n of ['lab', 'orders', 'lim', 'ghost']) expect(switchBtn(n), n).toBeTruthy();
  }, T);

  it('5-hour and 7-day progressbars carry the percentages; an account without a reading has none', async () => {
    setup();
    await ready();
    const c = within(card('lab'));
    const five = c.getByRole('progressbar', { name: '5-hour usage' });
    const seven = c.getByRole('progressbar', { name: '7-day usage' });
    expect(five.getAttribute('aria-valuenow')).toBe('40');
    expect(seven.getAttribute('aria-valuenow')).toBe('60');
    expect(five.getAttribute('aria-valuemin')).toBe('0');
    expect(five.getAttribute('aria-valuemax')).toBe('100');
    expect(within(card('ryan')).getByRole('progressbar', { name: '5-hour usage' }).getAttribute('aria-valuenow')).toBe('10');
    expect(within(card('lim')).getByRole('progressbar', { name: '5-hour usage' }).getAttribute('aria-valuenow')).toBe('100');
    expect(within(card('orders')).queryAllByRole('progressbar')).toHaveLength(0);
    expect(within(card('ghost')).queryAllByRole('progressbar')).toHaveLength(0);
  }, T);

  it('shows status in words, "refresh by" for a saved login, and "updated X ago" for a reading', async () => {
    setup();
    await ready();
    expect(card('lim').textContent).toMatch(/limit/i);
    expect(card('lab').textContent).toMatch(/refresh by/i);
    expect(card('lab').textContent).toMatch(/updated.*5m ago/i);
    expect(card('ghost').textContent).toMatch(/no saved login|not saved|sign in/i);
    expect(card('orders').textContent).not.toMatch(/updated.*ago/i);
  }, T);
});

describe('switching', () => {
  it('one click posts use with the name as JSON, asks no confirmation, and the page shows the new active account', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const h = { 'POST /api/accounts/use': (b, st) => { st.accounts.forEach((a) => { a.active = a.name === b.name; }); return { body: { from: 'ryan', to: b.name, switched: true } }; } };
    const s = setup(world(), { handlers: h });
    await ready();
    fireEvent.click(switchBtn('lab'));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await waitFor(() => expect(within(card('lab')).queryByText('Active')).toBeTruthy());
    expect(within(card('ryan')).queryByText('Active')).toBeNull();
    expect(s.postsTo('use')).toHaveLength(1);
    expect(s.postsTo('use')[0].body).toEqual({ name: 'lab' });
    expect(s.postsTo('use')[0].headers['Content-Type']).toBe('application/json');
    expect(confirm).not.toHaveBeenCalled();
    expect(switchBtn('lab')).toBeNull();
    expect(switchBtn('ryan')).toBeTruthy();
  }, T);

  it('the button is disabled while the switch is in flight, so a double click posts once', async () => {
    let release;
    const h = { 'POST /api/accounts/use': () => new Promise((r) => { release = () => r({ body: { from: 'ryan', to: 'lab', switched: true } }); }) };
    const s = setup(world(), { handlers: h });
    await ready();
    const b = switchBtn('lab');
    fireEvent.click(b);
    await waitFor(() => expect(s.postsTo('use')).toHaveLength(1));
    fireEvent.click(switchBtn('lab') ?? b);
    await settle(200);
    expect(s.postsTo('use')).toHaveLength(1);
    release();
  }, T);

  it('an account with no saved login, and a limited one, have a disabled switch with the reason shown; clicking posts nothing', async () => {
    const s = setup();
    await ready();
    const ghost = switchBtn('ghost');
    const lim = switchBtn('lim');
    expect(ghost.disabled).toBe(true);
    expect(lim.disabled).toBe(true);
    expect(card('ghost').textContent).toMatch(/no saved login|sign in|add/i);
    expect(card('lim').textContent).toMatch(/limit/i);
    fireEvent.click(ghost);
    fireEvent.click(lim);
    await settle(300);
    expect(s.postsTo('use')).toHaveLength(0);
    expect(switchBtn('lab').disabled).toBe(false);
    expect(switchBtn('orders').disabled).toBe(false);
  }, T);

  it('a refused switch shows the server error inside that card, leaves the active account alone and lets the user try again', async () => {
    const msg = 'the saved login for "lab" belongs to another account';
    const h = { 'POST /api/accounts/use': () => ({ status: 400, body: { error: msg } }) };
    setup(world(), { handlers: h });
    await ready();
    fireEvent.click(switchBtn('lab'));
    await waitFor(() => expect(card('lab').textContent).toContain(msg));
    expect(within(card('ryan')).queryByText('Active')).toBeTruthy();
    await waitFor(() => expect(switchBtn('lab').disabled).toBe(false));
  }, T);

  it('names the open chats that may need "continue" only when runs are live', async () => {
    setup(world({ liveRuns: 2 }));
    await ready();
    expect(document.body.textContent).toMatch(/open chats?/i);
    expect(document.body.textContent).toMatch(/continue/i);
    cleanup();
    setup(world({ liveRuns: 0 }));
    await ready();
    expect(document.body.textContent).not.toMatch(/open chats?/i);
  }, T);
});

describe('read-only', () => {
  it('enabled=false: a notice, no cards, no action buttons, and no POST', async () => {
    const s = setup({ enabled: false, accounts: [], liveReason: null, liveRuns: 0, refresh: null, signIn: null });
    await screen.findByRole('heading', { name: 'Accounts' });
    await waitFor(() => expect(document.body.textContent).toMatch(/read-only|turned off|switched off|disabled|not enabled|is off/i));
    expect(document.querySelectorAll('article[data-account]')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Refresh usage/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Add account/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Switch to this account/ })).toBeNull();
    await settle(300);
    expect(s.posts).toHaveLength(0);
  }, T);
});

describe('add account', () => {
  const addState = () => world({ accounts: [acct('ryan', { active: true, ...reading(10, 20, 5) })] });
  const open = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Add account' }));
    return screen.findByRole('textbox', { name: /name/i });
  };

  it('validates the name before posting; posts name and optional email; shows the sign-in link safely, the code box and Cancel', async () => {
    const handlers = {
      'POST /api/accounts/add': (b, st) => { st.signIn = { state: 'waiting', name: b.name, url: null, needsCode: false, error: null, startedAt: iso(NOW) }; return { status: 202, body: {} }; },
      'POST /api/accounts/add/code': (b, st) => { st.signIn = null; st.accounts.push(acct('newone', { email: 'new@example.com' })); return { body: {} }; },
      'POST /api/accounts/add/cancel': (b, st) => { st.signIn = null; return { body: {} }; },
    };
    const s = setup(addState(), { handlers });
    await ready();
    const name = await open();
    for (const bad of ['Bad Name', '1abc', 'x'.repeat(33), '', 'a/b']) {
      fireEvent.change(name, { target: { value: bad } });
      submit(name);
    }
    await settle(300);
    expect(s.postsTo('add'), 'invalid names must not be posted').toHaveLength(0);
    fireEvent.change(name, { target: { value: 'newone' } });
    fireEvent.change(screen.getByRole('textbox', { name: /email/i }), { target: { value: 'new@example.com' } });
    submit(name);
    await waitFor(() => expect(s.postsTo('add')).toHaveLength(1));
    expect(s.postsTo('add')[0].body).toEqual({ name: 'newone', email: 'new@example.com' });
    expect(s.postsTo('add')[0].headers['Content-Type']).toBe('application/json');
    // progress, then the link and the code box once the server reports them
    s.state.signIn = { state: 'waiting', name: 'newone', url: GOOD, needsCode: true, error: null, startedAt: iso(NOW) };
    const link = await screen.findByRole('link', { name: /sign|open|browser|claude/i });
    expect(link.getAttribute('href')).toBe(GOOD);
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toMatch(/noopener/);
    expect(link.getAttribute('rel')).toMatch(/noreferrer/);
    const code = await screen.findByRole('textbox', { name: /code/i });
    expect(screen.getByRole('button', { name: /^cancel$/i })).toBeTruthy();
    fireEvent.change(code, { target: { value: 'abc123#xyz' } });
    const btn = within(code.closest('form') ?? document.body).queryAllByRole('button').find((b) => /code|send|submit|continue|finish/i.test(b.textContent) && !/cancel/i.test(b.textContent));
    if (btn) fireEvent.click(btn); else submit(code);
    await waitFor(() => expect(s.postsTo('add/code')).toHaveLength(1));
    expect(s.postsTo('add/code')[0].body).toEqual({ code: 'abc123#xyz' });
    expect(s.postsTo('add')).toHaveLength(1);
    await waitFor(() => expect(card('newone')).toBeTruthy());
  }, T);

  it('Cancel posts add/cancel and the sign-in UI goes away', async () => {
    const handlers = {
      'POST /api/accounts/add': (b, st) => { st.signIn = { state: 'waiting', name: b.name, url: GOOD, needsCode: true, error: null, startedAt: iso(NOW) }; return { status: 202, body: {} }; },
      'POST /api/accounts/add/cancel': (b, st) => { st.signIn = null; return { body: {} }; },
    };
    const s = setup(addState(), { handlers });
    await ready();
    const name = await open();
    fireEvent.change(name, { target: { value: 'tmp' } });
    submit(name);
    await screen.findByRole('link', { name: /sign|open|browser|claude/i });
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    await waitFor(() => expect(s.postsTo('add/cancel')).toHaveLength(1));
    expect(s.postsTo('add/cancel')[0].body).toEqual({});
    await waitFor(() => expect(screen.queryByRole('textbox', { name: /code/i })).toBeNull());
    expect(screen.queryByRole('link', { name: /sign|open|browser|claude/i })).toBeNull();
  }, T);

  it('never makes a link out of a sign-in URL that is not https (defence in depth, the server filters first)', async () => {
    const s = setup(world({ accounts: [acct('ryan', { active: true, ...reading(10, 20, 5) })], signIn: { state: 'waiting', name: 'x', url: 'javascript:alert(1)', needsCode: false, error: null, startedAt: iso(NOW) } }));
    await ready();
    await settle(300);
    expect(document.querySelector('a[href^="javascript:"]')).toBeNull();
    s.state.signIn.url = 'http://evil.example/login';
    await settle(300);
    expect(document.querySelector('a[href^="http://evil.example"]')).toBeNull();
  }, T);

  it('a sign-in error is shown in words, as text', async () => {
    const handlers = { 'POST /api/accounts/add': (b, st) => { st.signIn = { state: 'starting', name: b.name, url: null, needsCode: false, error: null, startedAt: iso(NOW) }; return { status: 202, body: { signIn: st.signIn } }; } };
    const s = setup(addState(), { handlers });
    await ready();
    const name = await open();
    fireEvent.change(name, { target: { value: 'tmp' } });
    submit(name);
    await waitFor(() => expect(s.postsTo('add')).toHaveLength(1));
    s.state.signIn = { state: 'failed', name: 'tmp', url: null, needsCode: false, error: 'sign-in did not finish (exit 1)', startedAt: iso(NOW) };
    await waitFor(() => expect(document.body.textContent).toContain('sign-in did not finish (exit 1)'));
  }, T);
});

describe('refresh usage', () => {
  it('the button posts refresh with {} and per-account failures show inline', async () => {
    const h = { 'POST /api/accounts/refresh': (b, st) => { st.refresh = { running: false, at: iso(NOW), results: [{ name: 'lab', ok: true }, { name: 'orders', ok: false, error: 'Claude Code did not refresh the login (exit 1)' }] }; return { status: 202, body: {} }; } };
    const s = setup(world(), { handlers: h });
    await ready();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    await waitFor(() => expect(s.postsTo('refresh')).toHaveLength(1));
    expect(s.postsTo('refresh')[0].body).toEqual({});
    await waitFor(() => expect(document.body.textContent).toContain('did not refresh the login'));
  }, T);

  it('while a refresh is running the button cannot be pressed again', async () => {
    const s = setup(world({ refresh: { running: true, at: null, results: [] } }));
    await ready();
    const b = screen.getByRole('button', { name: /Refresh usage|Refreshing/ });
    expect(b.disabled || b.getAttribute('aria-disabled') === 'true' || b.getAttribute('aria-busy') === 'true').toBe(true);
    fireEvent.click(b);
    await settle(300);
    expect(s.postsTo('refresh')).toHaveLength(0);
  }, T);
});

describe('auto refresh on page open', () => {
  const stale = (min) => world({ accounts: [acct('ryan', { active: true, ...reading(10, 20, 2) }), acct('lab', reading(40, 60, min))] });
  const fresh = (st) => { st.accounts.forEach((a) => { if (a.readingAt) a.readingAt = iso(NOW - MIN); }); st.refresh = { running: false, at: iso(NOW), results: [] }; };

  it('a reading older than 30 minutes triggers exactly one refresh on open', async () => {
    const s = setup(stale(31), { handlers: { 'POST /api/accounts/refresh': (b, st) => { fresh(st); return { status: 202, body: {} }; } } });
    await ready();
    await waitFor(() => expect(s.postsTo('refresh')).toHaveLength(1));
    expect(s.postsTo('refresh')[0].body).toEqual({});
    await settle(700);
    expect(s.postsTo('refresh')).toHaveLength(1);
  }, T);

  it('a refresh that leaves the readings old does not loop', async () => {
    const s = setup(stale(90), { handlers: { 'POST /api/accounts/refresh': (b, st) => { st.refresh = { running: false, at: iso(NOW), results: [{ name: 'lab', ok: false, error: 'nope' }] }; return { status: 202, body: {} }; } } });
    await ready();
    await waitFor(() => expect(s.postsTo('refresh')).toHaveLength(1));
    await settle(1500);
    expect(s.postsTo('refresh')).toHaveLength(1);
  }, T);

  it('readings 29 minutes old or newer trigger nothing', async () => {
    const s = setup(stale(29));
    await ready();
    await settle(600);
    expect(s.postsTo('refresh')).toHaveLength(0);
  }, T);

  it('nothing is posted while a refresh is already running', async () => {
    const st = stale(90);
    st.refresh = { running: true, at: null, results: [] };
    const s = setup(st);
    await ready();
    await settle(600);
    expect(s.postsTo('refresh')).toHaveLength(0);
  }, T);

  it('the Monitor page never refreshes accounts', async () => {
    const s = setup(stale(90), { hash: '#/' });
    await settle(600);
    expect(s.postsTo('refresh')).toHaveLength(0);
    expect(s.posts).toHaveLength(0);
  }, T);
});

describe('text is rendered as text', () => {
  it('markup in an email, an error or a name never becomes elements', async () => {
    const evil = '<img src=x onerror=alert(1)>';
    setup(world({
      accounts: [acct('ryan', { active: true, email: `${evil}@x.example`, ...reading(10, 20, 5) })],
      refresh: { running: false, at: iso(NOW), results: [{ name: 'ryan', ok: false, error: evil }] },
    }));
    await ready();
    await settle(300);
    expect(document.querySelector('img[src="x"]')).toBeNull();
    expect(document.querySelector('[onerror]')).toBeNull();
  }, T);
});
