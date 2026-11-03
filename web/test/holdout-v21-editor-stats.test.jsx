// Holdout AC3/AC4: palette cards and the per-node stats line in the editor. Vitest + jsdom.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEditor } from '../src/editor/WorkflowEditor.jsx';
import { formatDuration, formatTokens } from '../src/lib/format.js';
import { typeName } from '../src/editor/model.js';
import { sample } from './fixtures.js';

const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 500, json: () => Promise.resolve(body) });
let puts;
let versionStats; // what /api/stats/versions returns, or a function that throws
let draftWf;

beforeEach(() => {
  puts = [];
  draftWf = sample();
  versionStats = [];
  globalThis.fetch = vi.fn((url, opts = {}) => {
    const m = opts.method ?? 'GET';
    if (url === '/api/workflow' && m === 'GET') return res({ published: { version: 3, workflow: sample(), publishedAt: '2026-10-20T10:00:00Z' }, draft: { workflow: draftWf, errors: [] } });
    if (url === '/api/workflow/versions') return res([{ version: 3, publishedAt: '2026-10-20T10:00:00Z', nodes: 5, stats: { finishedRuns: 4, avgTokens: 100, avgDurationMs: 1000 } }]);
    if (url === '/api/stats/versions') return typeof versionStats === 'function' ? versionStats() : res(versionStats);
    if (url === '/api/workflow/draft' && m === 'PUT') { puts.push(JSON.parse(opts.body).workflow); return res({ workflow: puts.at(-1), errors: [] }); }
    return res({});
  });
});
afterEach(() => vi.restoreAllMocks());

const open = async () => { render(<WorkflowEditor />); await screen.findByText('Published v3'); };
const card = (id) => document.querySelector(`[data-node="${id}"]`);
const statsOf = (id) => card(id)?.querySelector('.fnode-stats') ?? null;
const v3 = (over = {}) => ({ version: 3, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 4, avgTokens: 50_000, avgDurationMs: 200_000, nodes: [], ...over });
const nodeRow = (id, name, runs, avgTokens, avgDurationMs) => ({ id, name, runs, avgTokens, avgDurationMs });

describe('palette cards', () => {
  it('has one card per type with an icon, the type name and a visible one-line description', async () => {
    await open();
    const palette = screen.getByRole('complementary', { name: 'Node palette' });
    for (const t of ['step', 'check', 'gate', 'split', 'join', 'end']) {
      const b = palette.querySelector(`.palette-item.type-${t}`);
      expect(b, t).toBeTruthy();
      expect(b.querySelector('.palette-icon'), `${t} icon`).toBeTruthy();
      expect(b.textContent).toContain(typeName(t));
      const d = b.querySelector('.palette-desc');
      expect(d?.textContent.trim().length, `${t} description`).toBeGreaterThan(5);
      expect(d.textContent).not.toMatch(/\n/);
    }
    expect(palette.querySelectorAll('.palette-item')).toHaveLength(6);
    expect(within(palette).queryByRole('textbox')).toBeNull();
    expect(within(palette).queryByRole('searchbox')).toBeNull();
  });
  it('pressing a card still adds a node', async () => {
    await open();
    fireEvent.click(document.querySelector('.palette-item.type-gate'));
    await waitFor(() => expect(puts.at(-1)?.nodes.at(-1).type).toBe('gate'));
  });
  it('dragging a card sets the drag type, and a drop still adds a node', async () => {
    await open();
    const data = {};
    const dt = { setData: (k, v) => { data[k] = v; }, getData: (k) => data[k] ?? '', types: ['application/x-agent-monitor-node'], effectAllowed: '' };
    fireEvent.dragStart(document.querySelector('.palette-item.type-split'), { dataTransfer: dt });
    expect(data['application/x-agent-monitor-node']).toBe('split');
    fireEvent.drop(screen.getByRole('group', { name: 'Workflow canvas' }), { dataTransfer: dt, clientX: 300, clientY: 200 });
    await waitFor(() => expect(puts.at(-1)?.nodes.at(-1).type).toBe('split'));
  });
});

describe('editor stats line', () => {
  it('shows tokens and duration from the stats entry of the published version, with the shared formatters', async () => {
    versionStats = [v3({ nodes: [nodeRow('plan', 'PLAN', 3, 12_345, 250_000), nodeRow('verify', 'VERIFY', 2, 2_500_000, 3_725_000), nodeRow('gate2', 'GATE2', 4, 0, 61_000), nodeRow('pr', 'PR', 1, 999, 4000), nodeRow('done', 'DONE', 4, 0, 0)] })];
    await open();
    await waitFor(() => expect(statsOf('plan')).toBeTruthy());
    expect(statsOf('plan').textContent).toContain(`${formatTokens(12_345)} tokens`);
    expect(statsOf('plan').textContent).toContain(formatDuration(250_000));
    expect(statsOf('verify').textContent).toContain(`${formatTokens(2_500_000)} tokens`);
    expect(statsOf('verify').textContent).toContain(formatDuration(3_725_000));
    expect(statsOf('pr').textContent).toContain('999 tokens');
  });
  it('says "no runs yet" on every node when the version has no finished runs', async () => {
    versionStats = [v3({ finishedRuns: 0, nodes: ['plan', 'verify', 'gate2', 'pr', 'done'].map((id) => nodeRow(id, id, 0, 0, 0)) })];
    await open();
    await waitFor(() => expect(statsOf('plan')).toBeTruthy());
    for (const id of ['plan', 'verify', 'gate2', 'pr', 'done']) expect(statsOf(id).textContent.toLowerCase()).toContain('no runs yet');
  });
  it('says "never reached" for a node no finished run visited', async () => {
    versionStats = [v3({ nodes: [nodeRow('plan', 'PLAN', 4, 1000, 1000), nodeRow('verify', 'VERIFY', 0, 0, 0), nodeRow('gate2', 'G', 0, 0, 0), nodeRow('pr', 'PR', 0, 0, 0), nodeRow('done', 'D', 0, 0, 0)] })];
    await open();
    await waitFor(() => expect(statsOf('verify')).toBeTruthy());
    expect(statsOf('verify').textContent.toLowerCase()).toContain('never reached');
    expect(statsOf('plan').textContent).toContain('1.0k tokens');
  });
  it('shows nothing on a draft-only node', async () => {
    draftWf.nodes.push({ id: 'extra', type: 'step', name: 'EXTRA', runner: 'worker', model: 'sonnet', instructions: '', position: { x: 0, y: 200 } });
    versionStats = [v3({ nodes: ['plan', 'verify', 'gate2', 'pr', 'done'].map((id) => nodeRow(id, id, 1, 1000, 1000)) })];
    await open();
    await waitFor(() => expect(statsOf('plan')).toBeTruthy());
    expect(card('extra')).toBeTruthy();
    expect(statsOf('extra')).toBeNull();
  });
  it('uses the entry whose version equals the published one, not the newest', async () => {
    versionStats = [
      v3({ version: 4, finishedRuns: 9, nodes: [nodeRow('plan', 'PLAN', 9, 7_000_000, 1000)] }),
      v3({ nodes: [nodeRow('plan', 'PLAN', 3, 12_345, 250_000)] }),
    ];
    await open();
    await waitFor(() => expect(statsOf('plan')).toBeTruthy());
    expect(statsOf('plan').textContent).toContain('12k tokens');
    expect(statsOf('plan').textContent).not.toContain('7.0M');
  });
  it('a failing stats request never breaks the editor and shows no stats line', async () => {
    versionStats = () => res({ error: 'boom' }, false);
    await open();
    await waitFor(() => expect(card('plan')).toBeTruthy());
    await new Promise((r) => setTimeout(r, 50));
    expect(document.querySelector('.fnode-stats')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Node palette' })).toBeTruthy();
  });
  it('a rejected stats fetch is also harmless', async () => {
    versionStats = () => Promise.reject(new Error('offline'));
    await open();
    await waitFor(() => expect(card('plan')).toBeTruthy());
    expect(document.querySelector('.fnode-stats')).toBeNull();
  });
  it('editor cards use top and bottom handles', async () => {
    await open();
    await waitFor(() => expect(card('plan')).toBeTruthy());
    expect(card('plan').querySelector('.react-flow__handle-top')).toBeTruthy();
    expect(card('plan').querySelector('.react-flow__handle-bottom')).toBeTruthy();
    expect(card('plan').querySelector('.react-flow__handle-left')).toBeNull();
  });
});
