import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(import.meta.dirname, '../src/styles.css'), 'utf8');

// Body of the nth rule whose selector is exactly `selector` (no nested braces inside a token block).
function blockBody(selector, nth) {
  let from = -1;
  for (let i = 0; i <= nth; i++) {
    from = css.indexOf(`${selector} {`, from + 1);
    if (from < 0) throw new Error(`block ${nth} of ${selector} not found`);
  }
  const open = css.indexOf('{', from);
  return css.slice(open + 1, css.indexOf('}', open));
}
const decls = (body) => Object.fromEntries([...body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim().replace(/\s+/g, ' ')]));

const MEDIA = ":root:not([data-theme='light'])";
const DARK_ATTR = ":root[data-theme='dark']";
const theme = {
  light: decls(blockBody(':root', 0)),
  darkMedia: decls(blockBody(MEDIA, 0)),
  darkAttr: decls(blockBody(DARK_ATTR, 0)),
};
const series = {
  light: decls(blockBody(':root', 1)),
  darkMedia: decls(blockBody(MEDIA, 1)),
  darkAttr: decls(blockBody(DARK_ATTR, 1)),
};

// Tokens that are theme-independent live in the light block only.
const THEME_FREE = /^--(r|sp)-|^--font-/;
const themed = (o) => Object.keys(o).filter((k) => !THEME_FREE.test(k)).sort();

const KEY_TOKENS = [
  '--bg', '--surface', '--surface-2', '--surface-3', '--raised', '--text', '--text-2', '--muted', '--border', '--border-strong',
  '--accent', '--accent-hover', '--accent-text', '--link', '--focus', '--danger', '--ok', '--warn', '--warn-bg',
  '--run-pass', '--run-fail', '--run-wait', '--run-run', '--run-idle', '--tint', '--edge',
];

describe('theme tokens', () => {
  it('defines every key token in the light and both dark blocks', () => {
    for (const t of KEY_TOKENS) {
      expect(theme.light[t], `light ${t}`).toBeTruthy();
      expect(theme.darkMedia[t], `dark media ${t}`).toBeTruthy();
      expect(theme.darkAttr[t], `dark attr ${t}`).toBeTruthy();
    }
  });

  it('light and dark blocks define the same themed token names', () => {
    expect(themed(theme.darkMedia)).toEqual(themed(theme.light));
    expect(themed(theme.darkAttr)).toEqual(themed(theme.light));
  });

  it('keeps the two dark blocks identical', () => {
    expect(theme.darkAttr).toEqual(theme.darkMedia);
  });

  it('keeps the radius, spacing and font tokens in the light block', () => {
    for (const t of ['--r-xs', '--r-sm', '--r-md', '--r-lg', '--r-xl', '--r-pill', '--sp-1', '--sp-7', '--font-sans', '--font-mono']) {
      expect(theme.light[t], t).toBeTruthy();
    }
  });

  it('keeps the chart series blocks in sync', () => {
    const names = Object.keys(series.light).sort();
    for (let n = 1; n <= 8; n++) expect(names).toContain(`--series-${n}`);
    expect(names).toContain('--series-other');
    expect(Object.keys(series.darkMedia).sort()).toEqual(names);
    expect(series.darkAttr).toEqual(series.darkMedia);
  });

  it('loads no web font', () => {
    expect(css).not.toMatch(/@font-face|@import|url\(/);
  });
});
