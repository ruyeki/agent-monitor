// Holdout: parseAsk / splitCode contract (AC3).
import { describe, expect, it } from 'vitest';
import { parseAsk, splitCode } from '../src/lib/ask.js';

const T1907 = [
  '[CloudLab] T10.10 template requests: a new table, or a new type in the existing requests table?',
  'Background: Rohit settled the process. Chemical requests live in `requests` (rows).',
  'Proposal: a new template_requests table, reusing the Requests page. Backend PR first, then the admin and client screens.',
  'Options: A = new table (recommended) / B = new type in requests',
  'Answer: Resume with A or B, or Stop run.',
].join('\n');

describe('parseAsk', () => {
  it('empty-ish input gives no heading and no blocks', () => {
    for (const v of [null, undefined, '', '   ', '\n\n  \r\n']) expect(parseAsk(v)).toEqual({ heading: '', blocks: [] });
  });
  it('one-line ask is heading only', () => {
    expect(parseAsk("What's your solution?")).toEqual({ heading: "What's your solution?", blocks: [] });
    expect(parseAsk('  Accept, push and open the PR?  ').heading).toBe('Accept, push and open the PR?');
  });
  it('a heading that looks like a label is still the heading', () => {
    const r = parseAsk('Background: first line\nProposal: x');
    expect(r.heading).toBe('Background: first line');
    expect(r.blocks).toEqual([{ kind: 'row', label: 'Proposal', text: 'x' }]);
  });
  it('t1907 style ask: tagged heading verbatim, four labelled rows in order', () => {
    const r = parseAsk(T1907);
    expect(r.heading.startsWith('[CloudLab] T10.10 template requests:')).toBe(true);
    expect(r.blocks.map((b) => b.kind)).toEqual(['row', 'row', 'row', 'row']);
    expect(r.blocks.map((b) => b.label)).toEqual(['Background', 'Proposal', 'Options', 'Answer']);
    expect(r.blocks[0].text).toBe('Rohit settled the process. Chemical requests live in `requests` (rows).');
    expect(r.blocks[2].text).toBe('A = new table (recommended) / B = new type in requests');
  });
  it('handles CRLF and blank lines (no blocks for blanks)', () => {
    const r = parseAsk('Head\r\n\r\nBackground: b\r\n\r\n\r\nProposal: p\r\n');
    expect(r.heading).toBe('Head');
    expect(r.blocks).toEqual([{ kind: 'row', label: 'Background', text: 'b' }, { kind: 'row', label: 'Proposal', text: 'p' }]);
  });
  it('consecutive plain lines merge into one text block; a row or blank line ends it', () => {
    const r = parseAsk('Head\nline one\nline two\nBackground: b\nafter row\n\nnew para');
    expect(r.blocks).toEqual([
      { kind: 'text', text: 'line one\nline two' },
      { kind: 'row', label: 'Background', text: 'b' },
      { kind: 'text', text: 'after row' },
      { kind: 'text', text: 'new para' },
    ]);
  });
  it('label rules: up to 3 words, capitalised, max 24 chars, empty rest allowed', () => {
    const rows = (s) => parseAsk('H\n' + s).blocks;
    expect(rows('Next steps now: go')).toEqual([{ kind: 'row', label: 'Next steps now', text: 'go' }]);
    expect(rows('Answer:')).toEqual([{ kind: 'row', label: 'Answer', text: '' }]);
    expect(rows('lowercase: no')[0].kind).toBe('text');
    expect(rows('One two three four: no')[0].kind).toBe('text');
    expect(rows('Abcdefghijklmnopqrstuvwxyzabc: too long')[0].kind).toBe('text');
    expect(rows('See http://x.io for more')[0].kind).toBe('text');
    expect(rows('Time 12:30 is fine')[0].kind).toBe('text');
  });
  it('keeps HTML-like characters verbatim (no parsing or escaping)', () => {
    const r = parseAsk('<b>Head</b> & <script>alert(1)</script>\nNote: <img src=x onerror=1> &amp; "q"');
    expect(r.heading).toBe('<b>Head</b> & <script>alert(1)</script>');
    expect(r.blocks[0]).toEqual({ kind: 'row', label: 'Note', text: '<img src=x onerror=1> &amp; "q"' });
  });
  it('non-string input does not throw', () => {
    expect(() => parseAsk(42)).not.toThrow();
  });
});

describe('splitCode', () => {
  it('empty gives []', () => expect(splitCode('')).toEqual([]));
  it('plain text is one non-code segment', () => expect(splitCode('hello')).toEqual([{ code: false, text: 'hello' }]));
  it('inline code spans, backticks removed', () => {
    expect(splitCode('live in `requests` (x) and `a_b`')).toEqual([
      { code: false, text: 'live in ' }, { code: true, text: 'requests' }, { code: false, text: ' (x) and ' }, { code: true, text: 'a_b' },
    ]);
  });
  it('omits empty segments', () => {
    expect(splitCode('`a`')).toEqual([{ code: true, text: 'a' }]);
    expect(splitCode('`a``b`')).toEqual([{ code: true, text: 'a' }, { code: true, text: 'b' }]);
  });
  it('unpaired backtick stays literal', () => {
    expect(splitCode('a ` b')).toEqual([{ code: false, text: 'a ` b' }]);
    const r = splitCode('`a` and ` b');
    expect(r.map((s) => s.text).join('')).toContain('`');
    expect(r[0]).toEqual({ code: true, text: 'a' });
  });
  it('HTML inside code stays text', () => {
    expect(splitCode('`<b>x</b>`')).toEqual([{ code: true, text: '<b>x</b>' }]);
  });
});
