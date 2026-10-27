import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEditor } from '../src/editor/WorkflowEditor.jsx';
import { sample } from './fixtures.js';

const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
let fetchMock;
let puts;
let publishResult;

beforeEach(() => {
  puts = [];
  publishResult = () => res({ version: 4 });
  const state = { published: { version: 3, workflow: sample(), publishedAt: '2026-10-20T10:00:00Z' }, draft: { workflow: sample(), errors: [] } };
  fetchMock = vi.fn((url, opts = {}) => {
    const m = opts.method ?? 'GET';
    if (url === '/api/workflow' && m === 'GET') return res(state);
    if (url === '/api/workflow/versions') return res([{ version: 3, publishedAt: '2026-10-20T10:00:00Z', nodes: 5, stats: { finishedRuns: 4, avgTokens: 2_500_000, avgDurationMs: 125_000 } }, { version: 2, publishedAt: '2026-10-10T10:00:00Z', nodes: 4, stats: { finishedRuns: 0, avgTokens: 0, avgDurationMs: 0 } }]);
    if (url === '/api/workflow/draft' && m === 'PUT') {
      puts.push(JSON.parse(opts.body).workflow);
      return res({ workflow: puts.at(-1), errors: [] });
    }
    if (url === '/api/workflow/publish') return publishResult();
    return res({});
  });
  globalThis.fetch = fetchMock;
});
afterEach(() => vi.restoreAllMocks());

const open = async () => {
  render(<WorkflowEditor />);
  await screen.findByText('Published v3');
};
const outline = () => within(screen.getByRole('navigation', { name: 'Outline' }));
const pickNode = (name) => fireEvent.click(outline().getByRole('button', { name }));
const status = () => screen.getByRole('status').textContent;

describe('WorkflowEditor', () => {
  it('shows Published vN and Draft saved, then unsaved after an edit and saved after the PUT', async () => {
    await open();
    expect(status()).toBe('Draft — saved');
    pickNode('PLAN');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Planning' } });
    expect(status()).toBe('Draft — unsaved');
    await waitFor(() => expect(status()).toBe('Draft — saved'));
    expect(puts.at(-1).nodes[0].name).toBe('Planning');
  });

  it('shows the palette items and adds a node when one is pressed', async () => {
    await open();
    const palette = within(screen.getByRole('complementary', { name: 'Node palette' }));
    expect(palette.getAllByRole('button').map((b) => b.textContent)).toEqual(['Step', 'Check', 'Gate', 'Split', 'Join', 'End']);
    fireEvent.click(palette.getByRole('button', { name: 'Gate' }));
    await waitFor(() => expect(puts.at(-1)?.nodes.at(-1).type).toBe('gate'));
    expect(screen.getByLabelText('Ask')).toBeTruthy(); // the new node is selected
  });

  it('adds a node where a palette item is dropped on the canvas', async () => {
    await open();
    const dt = { getData: (t) => (t === 'application/x-agent-monitor-node' ? 'split' : ''), types: ['application/x-agent-monitor-node'] };
    fireEvent.drop(screen.getByRole('group', { name: 'Workflow canvas' }), { dataTransfer: dt, clientX: 300, clientY: 200 });
    await waitFor(() => expect(puts.at(-1)?.nodes.at(-1)).toMatchObject({ type: 'split', id: 'split-2' }));
  });

  it('edits every node field and the gate actions keep their edges', async () => {
    await open();
    pickNode('GATE2');
    for (const label of ['Id', 'Name', 'Type', 'Runner', 'Model', 'Instructions', 'Ask']) expect(screen.getByLabelText(label)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Action 1 label'), { target: { value: 'Approve' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove action 2' }));
    await waitFor(() => expect(status()).toBe('Draft — saved'));
    const saved = puts.at(-1);
    expect(saved.nodes.find((n) => n.id === 'gate2').actions).toEqual([{ label: 'Approve' }]);
    expect(saved.edges.filter((e) => e.from === 'gate2').map((e) => e.on)).toEqual(['Approve']);
  });

  it('renames a node id everywhere and rejects a taken id', async () => {
    await open();
    pickNode('PLAN');
    const id = screen.getByLabelText('Id');
    fireEvent.change(id, { target: { value: 'verify' } });
    fireEvent.blur(id);
    expect((await screen.findByRole('alert')).textContent).toMatch(/already uses/);
    fireEvent.change(id, { target: { value: 'frame' } });
    fireEvent.blur(id);
    await waitFor(() => expect(puts.at(-1)?.nodes[0].id).toBe('frame'));
    expect(puts.at(-1).edges.some((e) => e.from === 'frame')).toBe(true);
  });

  it('an edge offers the valid on choices for its source and a fix round checkbox', async () => {
    await open();
    fireEvent.click(outline().getByRole('button', { name: 'gate2 -Accept-> pr' }));
    const on = screen.getByLabelText('On');
    expect([...on.options].map((o) => o.value)).toEqual(['Accept', 'Stop run']);
    fireEvent.change(on, { target: { value: 'Stop run' } });
    await waitFor(() => expect(puts.at(-1).edges.find((e) => e.id === 'gate2>pr:Accept').on).toBe('Stop run'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete edge' }));
    await waitFor(() => expect(puts.at(-1).edges.some((e) => e.id === 'gate2>pr:Accept')).toBe(false));
  });

  it('nothing selected shows loop settings; the Delete key removes the selected node', async () => {
    await open();
    expect(screen.getByLabelText('Max rounds (1-10)').value).toBe('5');
    expect(screen.getByLabelText('Decision gate').value).toBe('gate2');
    fireEvent.change(screen.getByLabelText('Max rounds (1-10)'), { target: { value: '7' } });
    await waitFor(() => expect(puts.at(-1).loop.maxRounds).toBe(7));
    pickNode('PR');
    fireEvent.keyDown(window, { key: 'Delete' });
    await waitFor(() => expect(puts.at(-1).nodes.map((n) => n.id)).not.toContain('pr'));
    expect(puts.at(-1).edges.some((e) => e.from === 'pr' || e.to === 'pr')).toBe(false);
  });

  it('Delete in a text field does not delete the node', async () => {
    await open();
    pickNode('PR');
    fireEvent.keyDown(screen.getByLabelText('Name'), { key: 'Backspace' });
    expect(puts.length).toBe(0);
  });

  it('Delete on a focused button does not delete the node', async () => {
    await open();
    pickNode('PR');
    fireEvent.keyDown(screen.getByRole('button', { name: /^Delete/ }), { key: 'Delete' });
    expect(puts.length).toBe(0);
  });

  it('Publish refused: lists the errors, and pressing one selects its node', async () => {
    await open();
    publishResult = () => res({ errors: [{ message: "Node 'pr' pushes without a gate.", node: 'pr' }, { message: 'Edge is odd.', edge: 'plan>verify:done' }] }, false);
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    const list = await screen.findByRole('alert', { name: 'Publish errors' });
    fireEvent.click(within(list).getByRole('button', { name: /pushes without a gate/ }));
    expect(screen.getByLabelText('Id').value).toBe('pr');
    fireEvent.click(within(list).getByRole('button', { name: 'Edge is odd.' }));
    expect(screen.getByLabelText('On').value).toBe('done');
  });

  it('Auto-layout saves new positions; Discard asks first', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Auto-layout' }));
    await waitFor(() => expect(puts.length).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Discard the draft/);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/workflow/draft' && o?.method === 'DELETE')).toBe(false);
  });

  it('Versions lists versions and loads one into the draft', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Load v3 into draft' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/workflow/versions/3/load' && o?.method === 'POST')).toBe(true));
  });

  it('Versions shows finished runs, average tokens and duration per version', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Versions' }));
    const rows = screen.getAllByRole('row');
    const v3 = rows.find((r) => r.textContent.startsWith('v3')).textContent;
    expect(v3).toContain('2.5M');
    expect(v3).toContain('2m 5s');
    const v2 = rows.find((r) => r.textContent.startsWith('v2')).textContent;
    expect(v2).toMatch(/v2.*4.*0--/);
  });
});
