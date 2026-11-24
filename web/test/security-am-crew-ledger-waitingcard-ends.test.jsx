// White-hat probe for am-crew-ledger: the run page WaitingCard (Crew tab and Stages side panel) must ask to confirm an
// answer that ends the run (`ends: true`), like the Monitor inbox and Fleet do.
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WaitingCard } from '../src/WaitingCards.jsx';

const res = (body) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
let post;
beforeEach(() => {
  post = vi.fn(() => res({}));
  globalThis.fetch = vi.fn((url, opts = {}) => (opts.method === 'POST' ? post(url, JSON.parse(opts.body)) : res({})));
});
afterEach(() => vi.restoreAllMocks());

it('EXPOSURE: an ending answer on the run page WaitingCard is sent on the first click (no confirm)', async () => {
  const run = {
    id: 'r1', title: 'Run r1', stage: 'gate1', stageName: 'Gate 1', round: 0, maxRounds: 5, status: 'waiting',
    ask: 'Your solution?', actions: [{ label: 'Agree spec' }, { label: 'Stop run', ends: true }], textField: false, updatedAt: '2026-11-23T10:00:00Z',
  };
  render(<WaitingCard run={run} onDone={() => {}} />);
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Stop run' })));
  expect(post).not.toHaveBeenCalled(); // fails today: POST /api/runs/r1/respond {action:'Stop run'} went out at once
});

it('Confirm sends the ending answer once; Cancel sends nothing and returns focus to the answer; other answers stay one click', async () => {
  const run = {
    id: 'r1', title: 'Run r1', stage: 'gate1', stageName: 'Gate 1', round: 0, maxRounds: 5, status: 'waiting',
    ask: 'Your solution?', actions: [{ label: 'Agree spec' }, { label: 'Stop run', ends: true }], textField: false, updatedAt: '2026-11-23T10:00:00Z',
  };
  render(<WaitingCard run={run} onDone={() => {}} />);
  fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
  const group = screen.getByRole('group', { name: 'Confirm stop' });
  expect(document.activeElement).toBe(within(group).getByRole('button', { name: 'Cancel' }));
  fireEvent.click(within(group).getByRole('button', { name: 'Cancel' }));
  await Promise.resolve();
  expect(post).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Stop run' }));
  fireEvent.click(screen.getByRole('button', { name: 'Stop run' }));
  await act(async () => fireEvent.click(within(screen.getByRole('group', { name: 'Confirm stop' })).getByRole('button', { name: 'Confirm' })));
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/api/runs/r1/respond', { action: 'Stop run', text: '' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Agree spec' })));
  expect(post).toHaveBeenCalledTimes(2);
});
