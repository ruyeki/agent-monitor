import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WaitingCard } from '../src/WaitingCards.jsx';
import { parseAsk, splitCode } from '../src/lib/ask.js';

const T1907 =
  '[CloudLab] T10.10 template requests: a new table, or a new type in the existing requests table?\n' +
  'Background: Rohit settled the process. Chemical requests live in `requests` (table).\n' +
  'Proposal: a new template_requests table, reusing the Requests page.\n' +
  'Options: A = new table (recommended) / B = new type in requests\n' +
  'Answer: Resume with A or B, or Stop run.';

describe('parseAsk', () => {
  it('splits heading and labelled rows', () => {
    const a = parseAsk(T1907);
    expect(a.heading).toMatch(/^\[CloudLab\] T10\.10/);
    expect(a.blocks.map((b) => b.label)).toEqual(['Background', 'Proposal', 'Options', 'Answer']);
    expect(a.blocks[3]).toEqual({ kind: 'row', label: 'Answer', text: 'Resume with A or B, or Stop run.' });
  });
  it('merges consecutive plain lines and splits paragraphs on blank lines or rows', () => {
    const a = parseAsk('Head\none\ntwo\n\nthree\nNote: x\nfour');
    expect(a.blocks).toEqual([
      { kind: 'text', text: 'one\ntwo' },
      { kind: 'text', text: 'three' },
      { kind: 'row', label: 'Note', text: 'x' },
      { kind: 'text', text: 'four' },
    ]);
  });
  it('one-line, empty and missing asks', () => {
    expect(parseAsk("What's your solution?")).toEqual({ heading: "What's your solution?", blocks: [] });
    for (const v of [null, undefined, '', '  \n ']) expect(parseAsk(v)).toEqual({ heading: '', blocks: [] });
  });
  it('allows an empty row text and CRLF', () => {
    expect(parseAsk('H\r\nOptions:\r\n').blocks).toEqual([{ kind: 'row', label: 'Options', text: '' }]);
  });
  it('keeps URLs with a colon as plain text', () => {
    expect(parseAsk('H\nSee http://x.io for more').blocks).toEqual([{ kind: 'text', text: 'See http://x.io for more' }]);
    expect(parseAsk('H\nDocs at https://a.b/c').blocks).toEqual([{ kind: 'text', text: 'Docs at https://a.b/c' }]);
  });
  it('keeps HTML-like characters verbatim', () => {
    expect(parseAsk('a < b & c <script>').heading).toBe('a < b & c <script>');
  });
});

describe('splitCode', () => {
  it('extracts code spans', () => {
    expect(splitCode('use `x` now')).toEqual([
      { code: false, text: 'use ' },
      { code: true, text: 'x' },
      { code: false, text: ' now' },
    ]);
  });
  it('keeps an unpaired backtick literal; empty gives []', () => {
    expect(splitCode('a ` b')).toEqual([{ code: false, text: 'a ` b' }]);
    expect(splitCode('')).toEqual([]);
  });
});

describe('WaitingCard ask rendering', () => {
  const base = { id: 'r', title: 'T', stage: 'gate1', round: 1, maxRounds: 5, status: 'waiting', actions: [{ label: 'Resume' }] };
  it('renders heading, rows and code', () => {
    const { container } = render(<WaitingCard run={{ ...base, ask: T1907 }} />);
    expect(container.querySelector('h4.ask-heading').textContent).toMatch(/^\[CloudLab\]/);
    const rows = container.querySelectorAll('.ask-row');
    expect(rows).toHaveLength(4);
    expect(rows[0].querySelector('.ask-label').textContent).toBe('Background');
    expect(rows[0].querySelector('.ask-text code').textContent).toBe('requests');
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
  });
  it('renders HTML-like text as text', () => {
    const { container } = render(<WaitingCard run={{ ...base, ask: 'a < b & c\nNote: <script>alert(1)</script>' }} />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('.ask-heading').textContent).toBe('a < b & c');
    expect(container.querySelector('.ask-text').textContent).toBe('<script>alert(1)</script>');
  });
  it('renders nothing for an empty ask', () => {
    const { container } = render(<WaitingCard run={{ ...base, ask: null }} />);
    expect(container.querySelector('.ask')).toBeNull();
  });
});
