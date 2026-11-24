// The Ledger tab (contract C9): rows, tags, filter, summary rail, empty and error states, links, read-only.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunList } from '../src/RunList.jsx';
import { RunView } from '../src/run/RunView.jsx';
import { sample } from './fixtures.js';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
const tk = (total) => ({ input: total, output: 0, cacheWrite: 0, cacheRead: 0, total, cost: 0 });

const detail = (run = {}) => ({
  run: { id: 'r1', title: 'My run', stage: 'done', stageName: 'Done', round: 1, maxRounds: 5, status: 'done', active: [], actions: [], createdAt: iso(NOW - 7_200_000), updatedAt: iso(NOW - 60_000), endedAt: iso(NOW - 60_000), ...run },
  workflow: sample(), timeline: [], visits: [], nodes: {}, activity: [], agents: [],
  tokens: { nodes: tk(0), main: tk(0), unattributed: tk(0), total: tk(10) },
});

const item = (id, over) => ({ id, at: iso(NOW - 3_600_000), agentId: 'a1', kind: 'other', category: 'code', title: 'Something', chips: [], detail: '', tag: 'info', tagLabel: 'Ran once', ...over });
const ledger = () => ({
  items: [
    item('9', { kind: 'restart', category: 'machines', title: 'Restarted the Agent Monitor server', chips: ['this laptop'], tag: 'info', tagLabel: 'Ran once', at: iso(NOW - 3_120_000) }),
    item('8', { kind: 'db-upgrade', category: 'machines', title: 'Upgraded the database', chips: ['agent-monitor.db', 'schema v3 \u2192 v4'], detail: 'Backup: agent-monitor.db.bak', tag: 'backup', tagLabel: 'Backup kept' }),
    item('7', { kind: 'push', category: 'code', title: 'Pushed main to GitHub', chips: ['ruyeki/agent-monitor'], detail: 'Carries the commit below', tag: 'permanent', tagLabel: "Can't be undone" }),
    item('6', { kind: 'task-status', category: 'tasks', title: 'Set Hephaestus #2288 status', chips: ['Hephaestus', 'Done'], tag: 'reversible', tagLabel: 'Can change back' }),
    item('5', { kind: 'commit', category: 'code', title: 'Committed 274eae5 Answer waiting runs in a Decision Inbox', chips: ['git \u00b7 main', '+169', '\u2212120', '4 files'], stats: { files: 4, insertions: 169, deletions: 120 }, tag: 'info', tagLabel: 'Pushed' }),
    item('4', { kind: 'commit', category: 'code', title: 'Committed fix the thing', chips: ['git'], stats: null, tag: 'reversible', tagLabel: 'Can change back' }),
    item('3', { kind: 'worktree-add', category: 'machines', title: 'Created a worktree', chips: ['this laptop', 'C:\\wt\\x'], tag: 'reversible', tagLabel: 'Can change back' }),
  ],
  summary: { commits: 2, commitsWithStats: 1, files: 4, insertions: 4577, deletions: 295, pushes: 1, prs: 0, merges: 0, worktrees: 1, databases: 1, tasks: 1, restarts: 1, total: 7, permanent: [{ id: '7', title: 'Pushed main to GitHub', at: iso(NOW) }] },
});

let led;
let calls;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  led = ledger();
  calls = [];
  globalThis.fetch = vi.fn((url) => {
    calls.push(url);
    if (!String(url).endsWith('/ledger')) return res(detail());
    return led instanceof Error ? res({ error: led.message }, false) : res(led);
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const panel = () => screen.findByRole('region', { name: 'What this run changed' });
const rows = () => [...document.querySelectorAll('.lg')];
const loaded = async (n = 7) => {
  render(<RunView id="r1" tab="ledger" />);
  const p = await panel();
  await waitFor(() => expect(rows()).toHaveLength(n));
  return p;
};

describe('Ledger tab', () => {
  it('is the last tab, selected on /ledger, and fetches /api/runs/<id>/ledger', async () => {
    render(<RunView id="r1" tab="ledger" />);
    const tabs = within(await screen.findByRole('tablist', { name: 'Run views' }));
    expect(tabs.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Crew', 'Stages', 'Ledger']);
    expect(tabs.getByRole('tab', { name: 'Ledger' }).getAttribute('href')).toBe('#/runs/r1/ledger');
    expect(tabs.getByRole('tab', { name: 'Ledger' }).getAttribute('aria-selected')).toBe('true');
    await panel();
    expect(calls).toContain('/api/runs/r1/ledger');
  });

  it('draws one row per item with icon, title, chips, detail, tag (data-tag and label) and age', async () => {
    const p = await loaded();
    expect(within(p).getByRole('heading', { name: 'What this run changed' })).toBeTruthy();
    const push = rows()[2];
    expect(push.getAttribute('data-tag')).toBe('permanent');
    expect(push.querySelector('.tag').textContent).toBe("Can't be undone");
    expect(push.querySelector('.tag').getAttribute('data-tag')).toBe('permanent');
    expect(push.textContent).toContain('Pushed main to GitHub');
    expect(push.textContent).toContain('ruyeki/agent-monitor');
    expect(push.textContent).toContain('Carries the commit below');
    expect(push.querySelector('svg[aria-hidden="true"]')).toBeTruthy();
    expect(rows()[0].textContent).toContain('52m ago');
    expect(rows().map((r) => r.getAttribute('data-tag'))).toEqual(['info', 'backup', 'permanent', 'reversible', 'info', 'reversible', 'reversible']);
    expect(rows()[1].querySelector('.tag').textContent).toBe('Backup kept');
    expect(rows()[3].textContent).toContain('Set Hephaestus #2288 status');
    expect(rows()[3].textContent).toContain('Done');
  });

  it('a commit row shows hash, subject and +ins / -del / files once (from stats); none when stats are missing', async () => {
    await loaded();
    const c = rows()[4];
    expect(c.querySelector('.what .mono').textContent).toBe('274eae5');
    expect(c.querySelector('.what').textContent).toBe('Committed 274eae5 Answer waiting runs in a Decision Inbox');
    expect(c.querySelector('.ok').textContent).toBe('+169');
    expect(c.querySelector('.bad').textContent).toBe('\u2212120');
    expect(c.textContent.match(/4 files/g)).toHaveLength(1);
    expect(c.textContent).toContain('git \u00b7 main');
    const bare = rows()[5];
    expect(bare.querySelector('.ok')).toBeNull();
    expect(bare.textContent).toContain('Committed fix the thing');
  });

  it('the filter group keeps aria-pressed and shows All / Code / Tasks / Servers & data', async () => {
    const p = await loaded();
    const group = within(p).getByRole('group', { name: 'Filter' });
    const btn = (n) => within(group).getByRole('button', { name: n });
    expect(within(group).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Code', 'Tasks', 'Servers & data']);
    expect(btn('All').getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(btn('Code'));
    expect(btn('Code').getAttribute('aria-pressed')).toBe('true');
    expect(btn('All').getAttribute('aria-pressed')).toBe('false');
    expect(rows().map((r) => r.getAttribute('data-category'))).toEqual(['code', 'code', 'code']);
    fireEvent.click(btn('Tasks'));
    expect(rows()).toHaveLength(1);
    fireEvent.click(btn('Servers & data'));
    expect(rows()).toHaveLength(3);
    fireEvent.click(btn('All'));
    expect(rows()).toHaveLength(7);
  });

  it('the rail shows the summary and lists what cannot be undone', async () => {
    await loaded();
    const sum = screen.getByRole('region', { name: 'Summary' });
    expect(sum.textContent).toContain('7 changes');
    for (const [label, value] of [['Commits', '2'], ['Pushes', '1'], ['Worktrees', '1'], ['Database', '1'], ['Tasks updated', '1'], ['Restarts', '1']]) {
      expect(within(sum).getByText(label).nextElementSibling.textContent).toBe(value);
    }
    // the tiles add up to the total, and a kind with no changes has no tile
    const counts = [...sum.querySelectorAll('.lg-stat')].map((e) => Number(e.textContent));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(7);
    for (const gone of ['Pull requests', 'Merges', 'Files', 'Lines']) expect(within(sum).queryByText(gone)).toBeNull();
    // files and lines live in the Commits tile, from the commits whose stats are known
    const sub = within(sum).getByText('Commits').parentElement.querySelector('.lg-sub');
    expect(sub.textContent).toContain('4 files');
    expect(sub.textContent).toContain('+4,577 −295');
    expect(sub.textContent).toContain('from 1 of 2 commits');
    const perm = screen.getByRole('region', { name: "Can't be undone" });
    expect(perm.textContent).toContain('Pushed main to GitHub');
    expect(perm.querySelector('.tag').textContent).toBe('1');
    expect(document.body.textContent).toContain('Built from the tool calls Agent Monitor already logs');
  });

  it('Commits tile shows "–" for files and lines when no commit has stats, never 0', async () => {
    led.summary = { ...led.summary, commitsWithStats: 0, files: 0, insertions: 0, deletions: 0 };
    await loaded();
    const sub = within(screen.getByRole('region', { name: 'Summary' })).getByText('Commits').parentElement.querySelector('.lg-sub');
    expect(sub.textContent).toBe('– files · – lines');
  });

  it('an empty summary draws no tiles', async () => {
    led = { items: [], summary: { commits: 0, commitsWithStats: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, prs: 0, merges: 0, worktrees: 0, databases: 0, tasks: 0, restarts: 0, total: 0, permanent: [] } };
    render(<RunView id="r1" tab="ledger" />);
    await screen.findByText('Nothing changed yet.');
    expect(document.querySelectorAll('.lg-stat')).toHaveLength(0);
  });

  it('empty ledger: "Nothing changed yet." and "Every change in this run can be undone."', async () => {
    led = { items: [], summary: { commits: 0, files: 0, insertions: 0, deletions: 0, pushes: 0, tasks: 0, restarts: 0, total: 0, permanent: [] } };
    render(<RunView id="r1" tab="ledger" />);
    expect(await screen.findByText('Nothing changed yet.')).toBeTruthy();
    expect(screen.getByText('Every change in this run can be undone.')).toBeTruthy();
    expect(rows()).toHaveLength(0);
  });

  it('shows an error with role=alert when the fetch fails, not the empty note', async () => {
    led = new Error('boom');
    render(<RunView id="r1" tab="ledger" />);
    expect(await screen.findByText(/Could not load the ledger: boom/)).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('boom');
    expect(screen.queryByText('Nothing changed yet.')).toBeNull();
  });

  it('is read-only: no undo, revert or restore button anywhere', async () => {
    await loaded();
    const names = screen.getAllByRole('button').map((b) => b.textContent);
    expect(names.filter((n) => /undo|revert|restore|roll ?back/i.test(n))).toEqual([]);
    expect(within(document.querySelector('.ledger-main')).getAllByRole('button').map((b) => b.textContent)).toEqual(['All', 'Code', 'Tasks', 'Servers & data']);
  });

  it('item text is plain text: markup in a title, chip or detail is not parsed', async () => {
    led = { items: [item('1', { title: '<img src=x onerror="window.__pwn=1">', chips: ['<b>x</b>'], detail: '<script>window.__pwn=2</script>' })], summary: { total: 1, permanent: [] } };
    await loaded(1);
    expect(document.querySelector('.lg img, .lg b, .lg script')).toBeNull();
    expect(rows()[0].textContent).toContain('<img src=x');
    expect(window.__pwn).toBeUndefined();
  });

  it('refetches on the live tick, at most once per 3 s', async () => {
    vi.useRealTimers();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const { rerender } = render(<RunView id="r1" tab="ledger" tick={0} />);
    const n = () => calls.filter((u) => u.endsWith('/ledger')).length;
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(n()).toBe(1);
    for (let t = 1; t <= 5; t++) {
      rerender(<RunView id="r1" tab="ledger" tick={t} />);
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    }
    expect(n()).toBeLessThanOrEqual(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(3500); });
    expect(n()).toBe(2);
  });
});

describe('links into the run', () => {
  const run = (over) => ({ id: 'r1', title: 'T', stage: 'done', stageName: 'Done', round: 1, maxRounds: 5, status: 'done', active: [], createdAt: iso(NOW - 1000), ...over });
  it('a finished row opens the Ledger tab, a live row the Crew tab', () => {
    render(<RunList runs={[run(), run({ id: 'r2', status: 'active', stage: 'plan', stageName: 'Plan', active: [{ id: 'plan', name: 'Plan' }] }), run({ id: 'r3', status: 'stopped' })]} />);
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual(['#/runs/r1/ledger', '#/runs/r2/crew', '#/runs/r3/ledger']);
  });
});
