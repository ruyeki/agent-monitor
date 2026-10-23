import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkflowEditor } from '../src/editor/WorkflowEditor.jsx';
import { sample } from './fixtures.js';

const res = (body, ok = true) => Promise.resolve({ ok, status: ok ? 200 : 400, json: () => Promise.resolve(body) });
let fetchMock;
let puts;

beforeEach(() => {
  puts = [];
  const state = { published: { version: 3, workflow: sample(), publishedAt: '2026-10-20T10:00:00Z' }, draft: { workflow: sample(), errors: [] } };
  fetchMock = vi.fn((url, opts = {}) => {
    const m = opts.method ?? 'GET';
    if (url === '/api/workflow' && m === 'GET') return res(state);
    if (url === '/api/workflow/versions') return res([{ version: 3, publishedAt: '2026-10-20T10:00:00Z', stages: 6 }]);
    if (url === '/api/workflow/draft' && m === 'PUT') {
      puts.push(JSON.parse(opts.body).workflow);
      return res({ workflow: puts.at(-1), errors: [] });
    }
    if (url === '/api/workflow/draft' && m === 'DELETE') return res({ workflow: sample(), errors: [] });
    return res({});
  });
  globalThis.fetch = fetchMock;
});
afterEach(() => vi.restoreAllMocks());

const open = async () => {
  render(<WorkflowEditor />);
  await screen.findByText('Published v3');
};
const list = () => within(screen.getByRole('navigation', { name: 'Stages' }));
const pick = (name) => fireEvent.click(list().getByRole('button', { name: new RegExp(name) }));

describe('WorkflowEditor', () => {
  it('shows the legend and marks an edit unsaved, then saved after the PUT', async () => {
    await open();
    expect(screen.getByText(/Any step: regression, env or stuck/)).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('Draft — saved');
    pick('PLAN');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Planning' } });
    expect(screen.getByRole('status').textContent).toBe('Draft — unsaved changes');
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft — saved'));
    expect(puts.at(-1).stages[0].name).toBe('Planning');
  });

  it('shows a save error with its message', async () => {
    await open();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, opts) => (opts?.method === 'PUT' ? res({ error: 'disk full' }, false) : base(url, opts)));
    pick('PLAN');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    expect((await screen.findByText(/disk full/)).textContent).toMatch(/Could not save/);
  });

  it('Move left reorders the stage', async () => {
    await open();
    pick('REVIEW');
    fireEvent.click(screen.getByRole('button', { name: 'Move left' }));
    const names = list().getAllByRole('button').map((b) => b.textContent);
    expect(names.slice(0, 4)).toEqual(['1. PLAN', '2. REVIEW', '3. VERIFY', '4. White-hat']);
    await waitFor(() => expect(puts.at(-1).stages.map((s) => s.id).slice(0, 3)).toEqual(['plan', 'review', 'verify']));
  });

  it('adds a step after the selection with a unique id and deletes it after an in-page confirm', async () => {
    await open();
    pick('PLAN');
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }));
    expect(screen.getByLabelText('Id').value).toBe('step-2');
    expect(list().getAllByRole('button')[1].textContent).toBe('2. New step');
    fireEvent.click(screen.getByRole('button', { name: 'Delete stage' }));
    expect(screen.getByRole('alertdialog').textContent).toMatch(/Delete stage step-2/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    expect(list().queryByText('2. New step')).toBeNull();
  });

  it('lists server errors when Publish returns 400', async () => {
    await open();
    const base = fetchMock.getMockImplementation();
    fetchMock.mockImplementation((url, opts) => (url === '/api/workflow/publish' ? res({ errors: ['Stage plan needs a name.'] }, false) : base(url, opts)));
    fireEvent.click(screen.getByRole('button', { name: 'Publish' }));
    expect(await screen.findByText('Stage plan needs a name.')).toBeTruthy();
  });

  it('Discard needs an in-page confirm, then DELETEs the draft', async () => {
    await open();
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(fetchMock.mock.calls.some(([u, o]) => u === '/api/workflow/draft' && o?.method === 'DELETE')).toBe(true));
  });

  it('edits loop settings when nothing is selected', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Max rounds'), { target: { value: '3' } });
    await waitFor(() => expect(puts.at(-1).loop.maxRounds).toBe(3));
  });
  it('renames a stage only on blur or Enter, and only to a valid unused id', async () => {
    await open();
    pick('PLAN');
    const id = () => screen.getByLabelText('Id');
    for (const bad of ['', 'review', 'Bad Id', 'fix', 'next']) {
      fireEvent.change(id(), { target: { value: bad } });
      fireEvent.blur(id());
      expect(screen.getByRole('alert').textContent).toBeTruthy();
      expect(list().getAllByRole('button')[0].textContent).toBe('1. PLAN');
    }
    expect(fetchMock.mock.calls.some(([, o]) => o?.method === 'PUT')).toBe(false);
    fireEvent.change(id(), { target: { value: 'plan2' } });
    expect(screen.getByRole('status').textContent).toBe('Draft — saved'); // typing alone changes nothing
    fireEvent.keyDown(id(), { key: 'Enter' });
    await waitFor(() => expect(puts.at(-1).stages[0].id).toBe('plan2'));
    expect(screen.getByLabelText('Id').value).toBe('plan2');
  });

  it('saves an emptied Max rounds as null, not an empty string', async () => {
    await open();
    fireEvent.change(screen.getByLabelText('Max rounds'), { target: { value: '' } });
    await waitFor(() => expect(puts.at(-1).loop.maxRounds).toBeNull());
  });

  it('ignores the response of a save that Discard has outdated', async () => {
    await open();
    const base = fetchMock.getMockImplementation();
    let rejectPut;
    fetchMock.mockImplementation((url, opts) =>
      opts?.method === 'PUT' ? new Promise((_r, rej) => { rejectPut = () => rej(new Error('stale boom')); }) : base(url, opts));
    pick('PLAN');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'x' } });
    await waitFor(() => expect(rejectPut).toBeTypeOf('function'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard draft' }));
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(screen.getByRole('status').textContent).toBe('Draft — saved'));
    rejectPut();
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText(/stale boom/)).toBeNull();
    expect(screen.getByRole('status').textContent).toBe('Draft — saved');
  });

  it('drops a refetch that started before a local edit', async () => {
    const view = render(<WorkflowEditor tick={0} />);
    await screen.findByText('Published v3');
    const base = fetchMock.getMockImplementation();
    let release;
    fetchMock.mockImplementation((url, opts) =>
      url === '/api/workflow' && !opts?.method ? new Promise((r) => { release = () => r(base(url, opts)); }) : base(url, opts));
    view.rerender(<WorkflowEditor tick={1} />); // SSE tick: GET starts now
    await waitFor(() => expect(release).toBeTypeOf('function'));
    pick('PLAN');
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Mine' } });
    release();
    await new Promise((r) => setTimeout(r, 20));
    expect(list().getAllByRole('button')[0].textContent).toBe('1. Mine');
  });
});
