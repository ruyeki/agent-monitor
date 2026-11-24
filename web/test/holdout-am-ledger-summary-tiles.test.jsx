// Holdout A (UI): one tile per change kind, zero tiles hidden, files/lines inside the Commits tile, "–" when unknown.
import { render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunView } from '../src/run/RunView.jsx';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
const tk = (total) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost: 0 });
const detail = () => ({
  run: { id: 'r1', title: 'My run', stage: 'done', stageName: 'Done', round: 1, maxRounds: 5, status: 'done', active: [], actions: [], createdAt: iso(NOW - 7_200_000), updatedAt: iso(NOW - 60_000), endedAt: iso(NOW - 60_000) },
  workflow: sample(), timeline: [], visits: [], nodes: {}, activity: [], agents: [],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(10) },
});
const base = { commits: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, tasks: 0, restarts: 0, prs: 0, merges: 0, worktrees: 0, databases: 0, commitsWithStats: 0, total: 0, permanent: [] };
const it1 = { id: '1', at: iso(NOW - 3_600_000), agentId: 'a1', kind: 'other', category: 'code', title: 'Something', chips: [], detail: '', tag: 'info', tagLabel: 'Ran once' };

let led;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  globalThis.fetch = vi.fn((url) => (String(url).endsWith('/ledger') ? res(led) : res(detail())));
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function sum(summary, items = [it1]) {
  led = { items, summary: { ...base, ...summary } };
  render(<RunView id="r1" tab="ledger" />);
  await screen.findByRole('region', { name: 'What this run changed' });
  const el = await screen.findByRole('region', { name: 'Summary' });
  await waitFor(() => expect(el.textContent).toMatch(/changes?/));
  return el;
}
const tile = (el, label) => within(el).queryByText(label)?.parentElement ?? null;

describe('Ledger summary tiles', () => {
  it('shows a tile for every kind with a count, and none for zero kinds', async () => {
    const el = await sum({ commits: 2, pushes: 1, prs: 3, merges: 1, worktrees: 2, databases: 1, tasks: 4, restarts: 1, total: 15, commitsWithStats: 2, files: 5, insertions: 10, deletions: 2 });
    for (const [label, n] of [['Commits', '2'], ['Pushes', '1'], ['Pull requests', '3'], ['Merges', '1'], ['Worktrees', '2'], ['Database', '1'], ['Tasks updated', '4'], ['Restarts', '1']]) {
      expect(tile(el, label), label).not.toBeNull();
      expect(tile(el, label).textContent, label).toContain(n);
    }
    expect(el.textContent).toContain('15 changes');
  });

  it('hides tiles whose count is 0', async () => {
    const el = await sum({ pushes: 2, prs: 1, worktrees: 1, total: 4 });
    for (const l of ['Commits', 'Merges', 'Database', 'Tasks updated', 'Restarts']) expect(within(el).queryByText(l), l).toBeNull();
    expect(tile(el, 'Pushes').textContent).toContain('2');
    expect(tile(el, 'Pull requests').textContent).toContain('1');
    expect(tile(el, 'Worktrees').textContent).toContain('1');
    expect(el.textContent).toContain('4 changes');
  });

  it('Files and Lines are no longer standalone tiles; they sit inside the Commits tile', async () => {
    const el = await sum({ commits: 3, commitsWithStats: 3, files: 12, insertions: 340, deletions: 20, total: 3 });
    expect(within(el).queryByText('Files')).toBeNull();
    expect(within(el).queryByText('Lines')).toBeNull();
    const t = tile(el, 'Commits').textContent;
    expect(t).toContain('12 files');
    expect(t).toContain('+340');
    expect(t).toContain('20');
    expect(t).not.toMatch(/from \d+ of \d+/);
  });

  it('no commit has known stats: files and lines show a dash, never 0', async () => {
    const el = await sum({ commits: 2, commitsWithStats: 0, total: 2 });
    const t = tile(el, 'Commits').textContent;
    expect(t).toContain('–');
    expect(t).not.toMatch(/\+\s*0\b/);
    expect(t).not.toMatch(/\b0 files/);
  });

  it('partial stats: sums plus "from X of Y commits"', async () => {
    const el = await sum({ commits: 3, commitsWithStats: 2, files: 7, insertions: 50, deletions: 5, total: 3 });
    const t = tile(el, 'Commits').textContent;
    expect(t).toContain('7 files');
    expect(t).toMatch(/from 2 of 3 commits/);
  });

  it('total 0: a muted "No changes to count yet." in the summary, no tiles', async () => {
    led = { items: [], summary: { ...base } };
    render(<RunView id="r1" tab="ledger" />);
    const el = await screen.findByRole('region', { name: 'Summary' });
    await waitFor(() => expect(within(el).getByText('No changes to count yet.')).toBeTruthy());
    for (const l of ['Commits', 'Pushes', 'Pull requests', 'Restarts']) expect(within(el).queryByText(l)).toBeNull();
  });

  it('an older server without the new fields does not crash or show NaN', async () => {
    led = { items: [it1], summary: { commits: 1, files: 2, insertions: 3, deletions: 1, pushes: 1, tasks: 0, restarts: 0, total: 2, permanent: [] } };
    render(<RunView id="r1" tab="ledger" />);
    const el = await screen.findByRole('region', { name: 'Summary' });
    await waitFor(() => expect(el.textContent).toMatch(/2 changes/));
    expect(el.textContent).not.toMatch(/NaN|undefined/);
  });
});
