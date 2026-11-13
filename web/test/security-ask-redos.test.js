// Security: a lone \r (or \u2028/\u2029) after a long run of spaces made the ROW regex backtrack in O(n^2).
import { describe, expect, it } from 'vitest';
import { parseAsk } from '../src/lib/ask.js';

describe('parseAsk ReDoS', () => {
  for (const [name, sep] of [['\r', '\r'], ['\u2028', '\u2028'], ['\u2029', '\u2029']]) {
    it(`stays fast with many spaces then a lone ${name}`, () => {
      const text = 'Head\nA: ' + ' '.repeat(100_000) + 'x' + sep + 'y';
      const t = Date.now();
      const { blocks } = parseAsk(text);
      expect(Date.now() - t).toBeLessThan(500);
      expect(blocks).toHaveLength(1);
      expect(blocks[0]).toMatchObject({ kind: 'row', label: 'A' });
    });
  }
});
