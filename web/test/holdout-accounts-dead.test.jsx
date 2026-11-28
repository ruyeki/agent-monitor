import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AccountsPage } from '../src/accounts/AccountsPage.jsx';

const DEAD = 'The saved login no longer works: sign in again (Add account, same name).';
const iso = (ms) => new Date(ms).toISOString();
const acc = (o = {}) => ({
  name: 'a', email: null, active: false, saved: true, status: 'no-reading', fiveHour: null, sevenDay: null, fiveHourResetsAt: null,
  sevenDayResetsAt: null, left: null, limitedUntil: null, refreshExpiresAt: null, readingAt: null, ...o,
});
const reply = (status, body) => Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
let state;
beforeEach(() => {
  state = {
    enabled: true, liveReason: null, liveRuns: 0, signIn: null, refresh: null,
    accounts: [acc({ name: 'ryan', active: true }), acc({ name: 'lab' }), acc({ name: 'orders' })],
  };
  globalThis.fetch = vi.fn((url, opts = {}) => {
    if ((opts.method ?? 'GET') === 'GET') return reply(200, JSON.parse(JSON.stringify(state)));
    // the refresh finishes at once: lab's saved login is dead and gets marked
    state = {
      ...state,
      accounts: state.accounts.map((a) => (a.name === 'lab' ? { ...a, saved: false, status: 'no-login' } : a)),
      refresh: { running: false, at: iso(Date.now()), results: [{ name: 'ryan', ok: true, error: null }, { name: 'lab', ok: false, error: DEAD }, { name: 'orders', ok: true, error: null }] },
    };
    return reply(202, { refresh: { running: true, at: iso(Date.now()), results: [] } });
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AC5 dead login on the Accounts page', () => {
  it('shows the plain sentence on the dead account after Refresh usage', async () => {
    render(<AccountsPage tick={0} pollMs={20} />);
    await waitFor(() => expect(document.querySelector('article[data-account="lab"]')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Refresh usage' }));
    const card = document.querySelector('article[data-account="lab"]');
    expect(await within(card).findByText(`Refresh failed: ${DEAD}`)).toBeTruthy();
    expect(within(card).getAllByText(/No saved login/).length).toBeGreaterThan(0);
  });
});
