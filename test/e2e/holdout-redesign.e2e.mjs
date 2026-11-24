// Holdout e2e: Linear-style redesign (tokens, nav, controls, tables, cards, editor, stats, run states, contrast, themes, 390 px, no external requests).
// Run: WEB_DIR=<temp build> CHROME_PATH=<chrome> [HR_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-redesign.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { until, started, completed, REPO, makeRepo, STUB, mcpClient, runIdOf, req } from '../holdout-codex-helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
const SHOTS = process.env.HR_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-hr-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a temp build'); process.exit(2); }
if (path.resolve(webDir) === path.resolve(REPO, 'web', 'dist')) { console.error('refusing web/dist'); process.exit(2); }

const results = [];
const notes = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 400)]);
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const tmpDirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// ---------- static checks on the built CSS (AC4)
await check('built CSS: only the self-hosted Inter @font-face (same-origin file), no external url(), no @import of http', async () => {
  const dir = path.join(webDir, 'assets');
  const css = fs.readdirSync(dir).filter((f) => f.endsWith('.css')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  ok(css.length > 1000, 'no css found');
  ok((css.match(/@font-face/gi) || []).length === 1, 'want exactly one @font-face (Inter)');
  const font = /url\(\s*["']?\/?assets\/(InterVariable-[\w-]+\.woff2)/.exec(css);
  ok(font && fs.existsSync(path.join(dir, font[1])), 'the @font-face does not point at the bundled InterVariable woff2');
  ok(!/url\(\s*["']?(https?:)?\/\//i.test(css), 'external url() in css');
  ok(!/@import[^;]*(https?:)?\/\//i.test(css), '@import external');
  const html = fs.readFileSync(path.join(webDir, 'index.html'), 'utf8');
  ok(!/(href|src)=["'](https?:)?\/\//i.test(html), 'index.html loads an external resource');
});

// ---------- seed
const { startServer } = await import(new URL(`file:///${REPO}/src/server.js`).href);
const stubDir = tmp('am-hr-stub-');
fs.writeFileSync(path.join(stubDir, 'script.json'), JSON.stringify({ default: { events: [started('TUI'), completed()] } }));
const root = fs.realpathSync(tmp('am-hr-root-'));
makeRepo(root, 'repoA');
const projects = tmp('am-hr-proj-');
const tline = (id, ts, input, output) => JSON.stringify({ type: 'assistant', sessionId: 'sess-hr', timestamp: new Date(ts).toISOString(), message: { id, model: 'claude-sonnet-5-5-20261001', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } });
const rows = [];
for (const k of [0, 1, 2, 3, 5, 9, 20]) { const d = new Date(); d.setDate(d.getDate() - k); d.setHours(12, 0, 0, 0); rows.push(tline(`s-${k}`, d.getTime() - (k === 0 ? 5000 : 0), 20000 + k * 3000, 4000 + k * 100)); }
fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
fs.writeFileSync(path.join(projects, 'proj', 'sess-hr.jsonl'), rows.join('\n') + '\n');
const srv = await startServer({ port: 0, dataDir: tmp('am-hr-home-'), projectsDir: projects, webDir, usageIntervalMs: 500, codex: { command: process.execPath, args: [STUB, stubDir], root } });
const mcp = await mcpClient(srv.url);
const call = async (n, x) => (await mcp.call(n, x)).text;
const base = srv.url.replace(/\/$/, '');
const start = async (title, extra = {}) => runIdOf(await call('start_run', { title, ...extra }));
const done = (run, stage, outcome = 'done') => call('complete_stage', { run, stage, outcome });
const answer = (run, action) => call('respond', { run, action });
const toVerify = async (run) => { await done(run, 'frame'); await answer(run, 'Agree spec'); await done(run, 'plan'); await done(run, 'implement'); await done(run, 'prep'); };

const LONG = ['[CloudLab] T10.10 template requests: a new table, or a new type?', 'Background: Rohit settled the process. Chemical requests live in `requests`.', 'Proposal: a new template_requests table, reusing the Requests page.', 'Options: A = new table (recommended) / B = new type', 'Answer: Resume with A or B, or Stop run.'].join('\n');
const RB = await start('Waiting run'); await done(RB, 'frame');
const RL = await start('Escalated long ask'); await call('escalate', { run: RL, question: LONG });
const RC = await start('Decision run'); await toVerify(RC); await done(RC, 'verify', 'regression');
const RD = await start('Running run'); await toVerify(RD); await done(RD, 'verify', 'fail'); await done(RD, 'fix');
const RA = await start('Finished run');
await toVerify(RA); await done(RA, 'verify', 'pass'); for (const s of ['review', 'whitehat']) await done(RA, s, 'pass');
for (const s of ['commit', 'report']) await done(RA, s);
await answer(RA, 'Accept'); await done(RA, 'pr');
const RE = await start('Stopped run'); await done(RE, 'frame'); await req(srv.port, 'POST', `/api/runs/${RE}/stop`, { body: {} });
const codexRun = await start('Handed over run', { repo: 'repoA' });
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'PostToolUse', session_id: 'ui1', cwd: root, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: codexRun }, tool_response: {}, tool_use_id: 'x' } });
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'StopFailure', session_id: 'ui1', cwd: root, error: 'rate_limit', error_details: { resetsAt: Math.floor(Date.now() / 1000) + 7200 } } });
await until(async () => { const d = (await req(srv.port, 'GET', `/api/runs/${codexRun}`)).json; return d.run.provider === 'codex'; }, 8000);
await done(codexRun, 'frame');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const requests = [];
async function newPage(theme, width = 1400, height = 900, scheme) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme || (theme === 'dark' ? 'dark' : 'light'), reducedMotion: 'reduce' });
  if (theme === 'light' || theme === 'dark' || theme === 'system') await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* */ } }, theme);
  const p = await ctx.newPage();
  p.on('request', (r) => requests.push([r.url(), r.resourceType()]));
  p.on('pageerror', (e) => notes.push('pageerror ' + e));
  return { ctx, p };
}

// ---------- in-page helpers
const helpers = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  window.__rgba = rgba;
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  window.__ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  window.__bgOf = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let bg = [255, 255, 255, 1];
    for (const e of chain.reverse()) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg); }
    return bg;
  };
  window.__opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  window.__hue = (c) => { const [r, g2, b] = [c[0] / 255, c[1] / 255, c[2] / 255]; const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b), d = mx - mn; if (!d) return -1; let h = mx === r ? ((g2 - b) / d) % 6 : mx === g2 ? (b - r) / d + 2 : (r - g2) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
};

async function contrast(p) {
  await p.evaluate(helpers);
  return p.evaluate(() => {
    const bad = []; let n = 0;
    const els = [...document.querySelectorAll('body *')];
    for (const el of els) {
      if (el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let text = '';
      const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
      if (isField) text = (el.value ?? '') + (el.tagName === 'SELECT' ? 'x' : '');
      if (!text.trim()) continue;
      if (el.matches(':disabled') || el.closest('[disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const svgText = el instanceof SVGElement;
      const bg = window.__bgOf(el);
      let fg = window.__rgba(svgText ? cs.fill : cs.color);
      fg[3] *= window.__opacity(el);
      const eff = fg[3] < 1 ? [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1] : fg;
      const size = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && w >= 700);
      const ratio = window.__ratio(eff, bg); n++;
      if (ratio < (large ? 3 : 4.5) && el.closest('.react-flow__attribution')) { window.__attr = ratio.toFixed(2); continue; }
      if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').toString().split(' ')[0]} "${text.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
    }
    return { n, bad };
  });
}

const PAGES = [
  ['monitor', '#/'], ['workflow', '#/workflow'], ['stats', '#/stats'],
  ['run-waiting', `#/runs/${RB}`], ['run-decision', `#/runs/${RC}`], ['run-running', `#/runs/${RD}`], ['run-done', `#/runs/${RA}`], ['run-stopped', `#/runs/${RE}`], ['run-codex', `#/runs/${codexRun}`],
];
async function go(p, hash, name) {
  await p.goto(`${base}/${hash}`);
  if (name.startsWith('run-')) { await p.getByRole('group', { name: 'Run graph' }).waitFor({ timeout: 8000 }); await p.locator('.fnode[data-node="frame"]').waitFor({ timeout: 8000 }); }
  else if (name === 'workflow') await p.locator('.fnode[data-node="frame"]').waitFor({ timeout: 10000 });
  else if (name === 'stats') await p.locator('.stats-page .panel').first().waitFor({ timeout: 10000 });
  else await p.locator('.run-rows, .muted').first().waitFor({ timeout: 8000 });
  if (name === 'monitor') await p.locator('.inbox-pane').waitFor({ timeout: 8000 });
  await p.waitForTimeout(900);
}

// ---------- per theme
// The affectUI palette agreed for #2289 (mockups' aui-am.css), mapped onto the AM token names.
const LIGHT = { '--bg': '#f7f7f8', '--surface': '#ffffff', '--surface-2': '#f3f3f5', '--surface-3': '#ebebee', '--raised': '#ffffff', '--text': '#1d1d1f', '--text-2': '#3a3a3e', '--muted': '#5b5b60', '--faint': '#68686d', '--border': 'rgba(0,0,0,.07)', '--border-strong': 'rgba(0,0,0,.13)', '--accent': '#1d1d1f', '--accent-hover': '#3a3a3e', '--accent-text': '#ffffff', '--link': '#0b63c9', '--focus': '#3b7ddd', '--danger': '#bf271a', '--ok': '#1a7240', '--warn': '#994800', '--warn-bg': '#fff0dd', '--edge': '#86868c', '--run-run': '#0b63c9', '--run-idle': '#5b5b60' };
const DARK = { '--bg': '#111113', '--surface': '#1c1c1f', '--surface-2': '#242427', '--surface-3': '#2c2c30', '--raised': '#1c1c1f', '--text': '#ededef', '--text-2': '#c8c8cd', '--muted': '#a7a7ad', '--faint': '#94949a', '--border': 'rgba(255,255,255,.08)', '--border-strong': 'rgba(255,255,255,.15)', '--accent': '#ededef', '--accent-hover': '#d4d4d8', '--accent-text': '#111113', '--link': '#78bbff', '--focus': '#5b9bff', '--danger': '#ff8e80', '--ok': '#66d597', '--warn': '#ffb067', '--warn-bg': '#3e2e22', '--edge': '#76767d', '--run-run': '#78bbff', '--run-idle': '#a7a7ad' };
// The minifier may drop spaces and leading zeros inside custom property values.
const norm = (v) => String(v).replace(/\s+/g, '').replace(/([(,])0\./g, '$1.');
const THEME_FREE = { '--r-xs': '4px', '--r-sm': '6px', '--r-md': '8px', '--r-lg': '12px', '--r-xl': '16px', '--r-pill': '9999px', '--sp-1': '4px', '--sp-2': '8px', '--sp-3': '12px', '--sp-4': '16px', '--sp-5': '24px', '--sp-6': '32px', '--sp-7': '48px' };
const readVars = (names) => { const cs = getComputedStyle(document.documentElement); return Object.fromEntries(names.map((n) => [n, cs.getPropertyValue(n).trim().toLowerCase()])); };
const allVarNames = () => { const out = new Set(); for (const sh of document.styleSheets) for (const r of sh.cssRules) { const walk = (rule) => { if (rule.style) for (const p of rule.style) if (p.startsWith('--')) out.add(p); if (rule.cssRules) for (const x of rule.cssRules) walk(x); }; walk(r); } return [...out]; };

for (const theme of ['light', 'dark']) {
  const { ctx, p } = await newPage(theme);
  page = p;
  await go(p, '#/', 'monitor');
  const want = theme === 'light' ? LIGHT : DARK;

  await check(`[${theme}] tokens: palette values match the agreed table`, async () => {
    const got = await p.evaluate(readVars, Object.keys(want));
    const diff = Object.keys(want).filter((k) => norm(got[k]) !== norm(want[k])).map((k) => `${k}=${got[k] || '(unset)'} want ${want[k]}`);
    ok(!diff.length, diff.join('; '));
  });
  await check(`[${theme}] tokens: radius and spacing scale, fonts, tint, elevation exist`, async () => {
    const names = [...Object.keys(THEME_FREE), '--font-sans', '--font-mono', '--tint', '--elev-1', '--elev-2'];
    const got = await p.evaluate(readVars, names);
    const diff = Object.keys(THEME_FREE).filter((k) => got[k] !== THEME_FREE[k]).map((k) => `${k}=${got[k] || '(unset)'}`);
    ok(!diff.length, diff.join('; '));
    ok(/^inter/i.test(got['--font-sans']), `--font-sans ${got['--font-sans']}`);
    ok(/jetbrains mono/i.test(got['--font-mono']), `--font-mono ${got['--font-mono']}`);
    ok(got['--tint'] === (theme === 'light' ? '10%' : '14%'), `--tint ${got['--tint']}`);
    ok(got['--elev-1'] && got['--elev-2'], 'elevation tokens missing');
    // affectUI elevation: a 0.5px hairline ring plus a soft drop shadow
    if (theme === 'dark') ok(/rgba\(255, ?255, ?255, ?0?\.09\)/.test(got['--elev-1']) && /0 2px 10px/.test(got['--elev-1']), `--elev-1 ${got['--elev-1']}`);
    else ok(/rgba\(0, ?0, ?0, ?0?\.08\)/.test(got['--elev-1']) && /0 3px 12px/.test(got['--elev-1']), `--elev-1 ${got['--elev-1']}`);
    ok(theme === 'dark' ? /0 10px 30px/.test(got['--elev-2']) : /0 6px 24px/.test(got['--elev-2']), `--elev-2 ${got['--elev-2']}`);
  });
  await check(`[${theme}] series tokens unchanged`, async () => {
    const S = theme === 'light' ? ['#2a78d6', '#eb6834', '#0f8c7e', '#9c7400', '#c44f7c', '#008300', '#6250d6', '#e34948', '#8a93a3'] : ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767', '#7b8494'];
    const names = [...[1, 2, 3, 4, 5, 6, 7, 8].map((i) => `--series-${i}`), '--series-other'];
    const got = await p.evaluate(readVars, names);
    const diff = names.filter((n, i) => got[n] !== S[i]);
    ok(!diff.length, diff.map((n) => `${n}=${got[n]}`).join('; '));
  });
  await check(`[${theme}] base: body font 13px Inter-first, smoothing, bg = --bg`, async () => {
    const r = await p.evaluate(() => { const cs = getComputedStyle(document.body); return { ff: cs.fontFamily, fs: cs.fontSize, sm: cs.webkitFontSmoothing, bg: cs.backgroundColor, h1: getComputedStyle(document.querySelector('h1')).fontWeight }; });
    ok(/^"?inter/i.test(r.ff), `font-family ${r.ff}`);
    ok(r.fs === '13px', `font-size ${r.fs}`);
    ok(parseInt(r.h1, 10) >= 600, `h1 weight ${r.h1}`);
    const bg = await p.evaluate((c) => window.__rgba ? window.__rgba(c) : null, r.bg);
    if (theme === 'dark') ok(/rgb\(17, 17, 19\)/.test(r.bg), `body bg ${r.bg}`);
  });
  await check(`[${theme}] sidebar: active nav link is a surface lift (--surface card on the --side rail), not an accent fill; hairline; ~232px wide`, async () => {
    const r = await p.evaluate(() => {
      const a = document.querySelector('.side-nav a[aria-current="page"]'), i = document.querySelector('.side-nav a:not([aria-current])'), sb = document.querySelector('aside.sidebar');
      const root = getComputedStyle(document.documentElement);
      return { act: getComputedStyle(a).backgroundColor, inact: getComputedStyle(i).backgroundColor, rad: getComputedStyle(a).borderTopLeftRadius, w: sb.getBoundingClientRect().width, s3: root.getPropertyValue('--surface').trim(), s1: root.getPropertyValue('--side').trim(), acc: root.getPropertyValue('--accent').trim(), bw: getComputedStyle(sb).borderRightWidth, sbg: getComputedStyle(sb).backgroundColor, links: [...document.querySelectorAll('nav[aria-label="Sections"] a')].length };
    });
    await p.evaluate(helpers);
    const [act, acc, s3, s1, sbg] = await p.evaluate(({ a, c, d, e, f }) => [window.__rgba(a), window.__rgba(c), window.__rgba(d), window.__rgba(e), window.__rgba(f)], { a: r.act, c: r.acc, d: r.s3, e: r.s1, f: r.sbg });
    const rgb = (c) => JSON.stringify(c.slice(0, 3));
    ok(rgb(act) !== rgb(acc), 'active nav link has the accent fill');
    ok(rgb(act) === rgb(s3), `active nav link bg ${r.act} != --surface ${r.s3}`);
    ok(r.inact === 'rgba(0, 0, 0, 0)', `inactive nav link bg ${r.inact}`);
    ok(parseFloat(r.rad) >= 4 && parseFloat(r.rad) <= 8, `nav link radius ${r.rad}`);
    ok(r.w >= 220 && r.w <= 245, `sidebar width ${r.w}`);
    ok(r.bw === '1px', `sidebar right border ${r.bw}`);
    ok(rgb(sbg) === rgb(s1), `sidebar bg ${r.sbg} != --side ${r.s1}`);
    ok(r.links === 4, `nav links ${r.links}`);
  });
  await check(`[${theme}] sidebar: brand mark is an accent-family svg next to the text; no h1 in the sidebar`, async () => {
    const r = await p.evaluate(() => { const b = document.querySelector('aside.sidebar .brand'); const svg = b && b.querySelector('svg'); return { text: b && b.textContent.trim(), hidden: svg && svg.getAttribute('aria-hidden'), col: svg && getComputedStyle(svg).color, link: getComputedStyle(document.documentElement).getPropertyValue('--link').trim(), h1: document.querySelectorAll('aside.sidebar h1').length }; });
    ok(r.text === 'Agent Monitor', `brand text ${r.text}`);
    ok(r.hidden === 'true', 'brand svg is not aria-hidden');
    ok(r.h1 === 0, 'h1 in the sidebar');
    await p.evaluate(helpers);
    const [c, l] = await p.evaluate(({ a, b }) => [window.__rgba(a), window.__rgba(b)], { a: r.col, b: r.link });
    ok(JSON.stringify(c.slice(0, 3)) === JSON.stringify(l.slice(0, 3)), `brand mark colour ${r.col} != --link ${r.link}`);
  });
  await check(`[${theme}] controls: buttons radius 7-8px, not pill, text weight 500+ (decision inbox action)`, async () => {
    const r = await p.evaluate(() => { const b = document.querySelector('.inbox-pane .ui-dic__actions button'); const cs = getComputedStyle(b); return { rad: cs.borderTopLeftRadius, fw: cs.fontWeight, bw: cs.borderTopWidth }; });
    ok(['7px', '8px'].includes(r.rad), `button radius ${r.rad}`); // the vendored inbox buttons use the theme radius (8px) minus 1px
    ok(parseInt(r.fw, 10) >= 500, `button weight ${r.fw}`);
  });
  await check(`[${theme}] monitor: stat strip (3 tiles while something waits, 22px/600 values, 12px muted labels), run rows as a list, stage pill`, async () => {
    await go(p, '#/', 'monitor');
    const r = await p.evaluate(() => {
      const t = document.querySelector('.stat-strip'); const v = t && t.querySelector('.stat-value'); const l = t && t.querySelector('.stat-label');
      const rows = document.querySelector('ul.run-rows'); const pill = document.querySelector('.run-row .stage-pill');
      return t && { n: t.querySelectorAll('.stat').length, vfs: getComputedStyle(v).fontSize, vfw: getComputedStyle(v).fontWeight, lfs: getComputedStyle(l).fontSize, ls: rows && getComputedStyle(rows).listStyleType, prad: pill && getComputedStyle(pill).borderTopLeftRadius, tables: document.querySelectorAll('table').length };
    });
    ok(r, 'no stat strip');
    ok(r.n === 3, `stat tiles ${r.n}`); // the Needs you tile is hidden while the inbox shows (4 when nothing waits)
    ok(r.vfs === '22px' && r.vfw === '600', `stat value ${r.vfs}/${r.vfw}`);
    ok(r.lfs === '12px', `stat label size ${r.lfs}`);
    ok(r.ls === 'none', `run list style ${r.ls}`);
    ok(r.prad && parseFloat(r.prad) >= 4 && parseFloat(r.prad) <= 6, `stage chip radius ${r.prad}`); // affectUI chip: 5px
    ok(r.tables === 0, 'a table is on the Monitor page');
  });
  await check(`[${theme}] badges: pill, codex badge tinted not solid accent, status colours`, async () => {
    await go(p, '#/runs/' + codexRun, 'run-codex');
    const r = await p.evaluate(() => {
      const b = document.querySelector('.badge.codex'); if (!b) return null; const cs = getComputedStyle(b);
      return { rad: cs.borderTopLeftRadius, bg: cs.backgroundColor, col: cs.color, acc: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(), fs: cs.fontSize };
    });
    ok(r, 'no codex badge in run view');
    ok(parseFloat(r.rad) >= 4 && parseFloat(r.rad) <= 6, `badge radius ${r.rad}`); // affectUI tag: 5px
    await p.evaluate(helpers);
    const [bg, acc] = await p.evaluate(({ a, b }) => [window.__rgba(a), window.__rgba(b)], { a: r.bg, b: r.acc });
    ok(JSON.stringify(bg.slice(0, 3)) !== JSON.stringify(acc.slice(0, 3)), 'codex badge is a solid accent fill');
    ok(/^1[12](\.5)?px$/.test(r.fs), `badge font ${r.fs}`);
  });
  await check(`[${theme}] waiting cards (run view; frameless in the answer pane): radius 10px, full warn tint + ring (no left stripe), padding 16px, full width`, async () => {
    await go(p, `#/runs/${RB}`, 'run-waiting');
    const r = await p.evaluate(() => { const c = document.querySelector('.run-side .waiting-card'); const cs = getComputedStyle(c); return { rad: cs.borderTopLeftRadius, lw: cs.borderLeftWidth, lc: cs.borderLeftColor, warn: getComputedStyle(document.documentElement).getPropertyValue('--warn').trim(), pad: cs.paddingTop, bg: cs.backgroundColor, tw: c.getBoundingClientRect().width, pw: (() => { const pe = c.parentElement, pcs = getComputedStyle(pe); return pe.clientWidth - parseFloat(pcs.paddingLeft) - parseFloat(pcs.paddingRight); })(), shadow: cs.boxShadow }; });
    ok(r.rad === '10px', `card radius ${r.rad}`); // affectUI card radius
    ok(r.lw === '0px', `left edge ${r.lw} (no stripe)`);
    ok(!/rgba\(0, ?0, ?0, ?0\)|transparent/.test(r.bg), `card has no tint: ${r.bg}`);
    ok(r.pad === '16px', `padding ${r.pad}`);
    ok(Math.abs(r.tw - r.pw) < 2, 'card not full width');
    ok(r.shadow && r.shadow !== 'none' && /inset/.test(r.shadow), `no warn ring on the card: ${r.shadow}`);
    await p.screenshot({ path: path.join(SHOTS, `waiting-card-${theme}.png`) });
  });
  await check(`[${theme}] inputs: radius 8px, 1px --border-strong, focus = --focus border + ring`, async () => {
    await go(p, '#/', 'monitor');
    const ta = p.locator('.inbox-pane textarea').first();
    ok(await ta.count(), 'no textarea on waiting card');
    await ta.focus();
    const r = await p.evaluate(() => { const t = document.querySelector('.inbox-pane textarea'); const cs = getComputedStyle(t); const root = getComputedStyle(document.documentElement); return { rad: cs.borderTopLeftRadius, bc: cs.borderTopColor, bw: cs.borderTopWidth, shadow: cs.boxShadow, outline: cs.outlineStyle + ' ' + cs.outlineWidth, focus: root.getPropertyValue('--focus').trim() }; });
    ok(r.rad === '8px', `textarea radius ${r.rad}`);
    ok(r.bw === '1px', `border ${r.bw}`);
    await p.evaluate(helpers);
    const [bc, f] = await p.evaluate(({ a, b }) => [window.__rgba(a), window.__rgba(b)], { a: r.bc, b: r.focus });
    ok(JSON.stringify(bc.slice(0, 3)) === JSON.stringify(f.slice(0, 3)), `focused border ${r.bc} != --focus ${r.focus}`);
    ok((r.shadow && r.shadow !== 'none') || /solid [12]px/.test(r.outline), `no focus ring (${r.shadow} / ${r.outline})`);
    await p.keyboard.press('Tab'); await p.keyboard.press('Tab');
  });
  await check(`[${theme}] keyboard focus ring visible at full opacity on a button`, async () => {
    await go(p, '#/', 'monitor');
    // Tab on from wherever focus is (the inbox adds tab stops) until a button has keyboard focus.
    for (let i = 0; i < 30 && (await p.evaluate(() => document.activeElement?.tagName)) !== 'BUTTON'; i++) await p.keyboard.press('Tab');
    const r = await p.evaluate(() => { const e = document.activeElement; const cs = getComputedStyle(e); return { tag: e.tagName, ow: cs.outlineWidth, os: cs.outlineStyle, oc: cs.outlineColor, sh: cs.boxShadow }; });
    ok((r.os === 'solid' && parseFloat(r.ow) >= 2) || (r.sh && r.sh !== 'none'), `no ring on ${r.tag}: ${JSON.stringify(r)}`);
    if (r.os === 'solid') { await p.evaluate(helpers); const c = await p.evaluate((x) => window.__rgba(x), r.oc); ok(c[3] === 1, `focus ring alpha ${c[3]}`); }
  });
  await check(`[${theme}] editor: primary button accent bg + accent text; hover = --accent-hover; node card radius 10 / icon tile, no stripe / --raised; selected = --link border`, async () => {
    await go(p, '#/workflow', 'workflow');
    const r = await p.evaluate(() => {
      const pb = document.querySelector('button.primary'); const cs = getComputedStyle(pb); const root = getComputedStyle(document.documentElement);
      const n = document.querySelector('.fnode'); const nc = getComputedStyle(n);
      return { pbg: cs.backgroundColor, pcol: cs.color, acc: root.getPropertyValue('--accent').trim(), at: root.getPropertyValue('--accent-text').trim(), nrad: nc.borderTopLeftRadius, nlw: nc.borderLeftWidth, nbg: nc.backgroundColor, raised: root.getPropertyValue('--raised').trim(), nsh: nc.boxShadow, prad: cs.borderTopLeftRadius };
    });
    await p.evaluate(helpers);
    const q = await p.evaluate((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, window.__rgba(v).slice(0, 3).join(',')])), { pbg: r.pbg, pcol: r.pcol, acc: r.acc, at: r.at, nbg: r.nbg, raised: r.raised });
    ok(q.pbg === q.acc, `primary bg ${r.pbg} != accent ${r.acc}`);
    ok(q.pcol === q.at, `primary text ${r.pcol}`);
    ok(r.prad === '8px', `primary radius ${r.prad}`);
    ok(r.nrad === '10px', `node radius ${r.nrad}`);
    ok(r.nlw === '1px', `node edge ${r.nlw}`); // the type colour moved from a 4px stripe to the icon tile
    ok(q.nbg === q.raised, `node bg ${r.nbg} != --raised ${r.raised}`);
    { const pt = await p.evaluate(() => { for (const n of document.querySelectorAll('.fnode')) { const r = n.getBoundingClientRect(); const x = r.x + r.width / 2, y = r.y + r.height / 2; if (y > 110 && y < innerHeight - 10 && x > 240 && x < innerWidth - 400) { const e = document.elementFromPoint(x, y); if (n.contains(e)) return [x, y]; } } return null; }); ok(pt, 'no node visible in the canvas viewport'); await p.mouse.click(pt[0], pt[1]); }
    await p.waitForTimeout(300);
    const s = await p.evaluate(() => { const n = document.querySelector('.fnode.selected'); if (!n) return null; const cs = getComputedStyle(n); return { bc: cs.borderTopColor, sh: cs.boxShadow, acc: getComputedStyle(document.documentElement).getPropertyValue('--link').trim() }; });
    ok(s, 'no selected node');
    const [bc, a] = await p.evaluate(({ a, b }) => [window.__rgba(a), window.__rgba(b)], { a: s.bc, b: s.acc });
    ok(JSON.stringify(bc.slice(0, 3)) === JSON.stringify(a.slice(0, 3)), `selected border ${s.bc}`);
    ok(s.sh && s.sh !== 'none', 'no selection ring');
    await p.locator('button.primary').first().hover(); await p.waitForTimeout(450);
    const hb = await p.evaluate(() => getComputedStyle(document.querySelector('button.primary')).backgroundColor);
    const hov = await p.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent-hover').trim());
    const [h1, h2] = await p.evaluate(({ a, b }) => [window.__rgba(a), window.__rgba(b)], { a: hb, b: hov });
    ok(JSON.stringify(h1.slice(0, 3)) === JSON.stringify(h2.slice(0, 3)), `primary hover bg ${hb} != --accent-hover ${hov}`);
    await p.screenshot({ path: path.join(SHOTS, `workflow-${theme}.png`) });
  });
  await check(`[${theme}] editor layout contract: palette 220px, canvas has xyflow vars; edges coloured by --edge`, async () => {
    const r = await p.evaluate(() => { const c = document.querySelector('.canvas'); const cs = getComputedStyle(c); return { edge: cs.getPropertyValue('--xy-edge-stroke').trim(), root: getComputedStyle(document.documentElement).getPropertyValue('--edge').trim(), bgc: cs.getPropertyValue('--xy-background-color').trim(), cols: getComputedStyle(document.querySelector('.editor-body')).gridTemplateColumns }; });
    ok(/^220px/.test(r.cols), `columns ${r.cols}`);
    ok(r.edge, 'no --xy-edge-stroke');
  });
  await check(`[${theme}] stats: panel radius 10px, KPI figure 22/600, segmented toggle on = --surface (not accent), chart-wrap radius 10`, async () => {
    await go(p, '#/stats', 'stats');
    const r = await p.evaluate(() => {
      const root = getComputedStyle(document.documentElement);
      const card = document.querySelector('.stats-page .panel'); const big = document.querySelector('.stat-strip .stat-value'); const on = document.querySelector('.toggle button.on'); const cw = document.querySelector('.chart-wrap');
      return { crad: getComputedStyle(card).borderTopLeftRadius, bfs: getComputedStyle(big).fontSize, bfw: getComputedStyle(big).fontWeight, btn: getComputedStyle(big).fontVariantNumeric, onbg: on && getComputedStyle(on).backgroundColor, s3: root.getPropertyValue('--surface').trim(), acc: root.getPropertyValue('--accent').trim(), cwr: cw && getComputedStyle(cw).borderTopLeftRadius, tgl: getComputedStyle(document.querySelector('.toggle')).borderTopWidth };
    });
    ok(r.crad === '10px', `panel radius ${r.crad}`);
    ok(r.bfs === '22px' && r.bfw === '600', `KPI figure ${r.bfs}/${r.bfw}`);
    ok(/tabular/.test(r.btn), `tabular-nums missing (${r.btn})`);
    ok(r.cwr === '10px', `chart-wrap radius ${r.cwr}`);
    await p.evaluate(helpers);
    const [bg, s3, acc] = await p.evaluate(({ a, b, c }) => [window.__rgba(a), window.__rgba(b), window.__rgba(c)], { a: r.onbg, b: r.s3, c: r.acc });
    ok(JSON.stringify(bg.slice(0, 3)) !== JSON.stringify(acc.slice(0, 3)), 'toggle .on is an accent fill');
    ok(JSON.stringify(bg.slice(0, 3)) === JSON.stringify(s3.slice(0, 3)), `toggle on bg ${r.onbg} != --surface ${r.s3}`);
    await p.screenshot({ path: path.join(SHOTS, `stats-${theme}.png`), fullPage: true });
  });
  await check(`[${theme}] stats: primary Save button radius 8px, number inputs radius 8px; chart bars use series tokens`, async () => {
    const r = await p.evaluate(() => { const i = document.querySelector('.stats-page input[type=number]'); const s = [...document.querySelectorAll('.chart-wrap svg rect, .chart-wrap svg path')].map((x) => x.getAttribute('fill') || ''); return { irad: i && getComputedStyle(i).borderTopLeftRadius, fills: [...new Set(s)].slice(0, 6) }; });
    if (r.irad) ok(r.irad === '8px', `number input radius ${r.irad}`);
    else notes.push('no number input on stats');
  });
  await check(`[${theme}] run states: hue families, status text present (never colour alone), idle differs, tint formula`, async () => {
    const out = {};
    for (const [nm, id] of [['RB', RB], ['RC', RC], ['RD', RD], ['RA', RA], ['RE', RE]]) {
      await go(p, '#/runs/' + id, 'run-x');
      await p.evaluate(helpers);
      Object.assign(out, await p.evaluate((nm2) => {
        const o = {};
        for (const n of document.querySelectorAll('.fnode')) {
          const cs = getComputedStyle(n); const st = n.dataset.state;
          if (!st) continue;
          const key = `${st}`;
          if (o[key]) continue;
          // use a right-hand border: the left edge is the type stripe
          o[key] = { border: cs.borderTopColor, bg: cs.backgroundColor, status: n.querySelector('.fnode-status')?.textContent.trim() ?? null, node: n.dataset.node, hueB: window.__hue(window.__rgba(cs.borderTopColor)), hueBg: window.__hue(window.__rgba(cs.backgroundColor)), bgs: window.__rgba(cs.backgroundColor).slice(0, 3).join(',') };
        }
        return o;
      }, nm));
    }
    const inR = (h, lo, hi) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi);
    const need = { passed: [80, 175], failed: [340, 20], decision: [340, 20], running: [190, 265], waiting: [25, 65] };
    for (const [st, [lo, hi]] of Object.entries(need)) {
      ok(out[st], `no ${st} node found in the fixture`);
      ok(inR(out[st].hueB, lo, hi), `${st} border hue ${out[st].hueB.toFixed(0)} not in ${lo}-${hi}`);
      ok(out[st].status, `${st} node has no status text`);
    }
    ok(out.idle, 'no idle node');
    ok(out.idle.border !== out.passed.border && out.idle.border !== out.running.border, 'idle border equals passed/running');
    // tinted background: the card colour must differ between passed and idle
    ok(out.passed.bgs !== out.idle.bgs && out.running.bgs !== out.idle.bgs, 'run-state tint absent (same bg as idle)');
    ok(out.halted, 'no halted node');
    ok(out.halted.status, 'halted node has no status text');
  });
  await check(`[${theme}] nothing uses a gradient background; no button is pill-shaped`, async () => {
    const bad = [];
    for (const [nm, h] of PAGES) {
      await go(p, h, nm);
      bad.push(...await p.evaluate((n) => [...document.querySelectorAll('body *')].flatMap((e) => { const cs = getComputedStyle(e); const o = []; if (/gradient/.test(cs.backgroundImage)) o.push(`${n}:${e.tagName}.${e.className} gradient`); if (e.tagName === 'BUTTON' && parseFloat(cs.borderTopLeftRadius) > 20) o.push(`${n}:button.${e.className} r=${cs.borderTopLeftRadius}`); return o; }), nm));
    }
    ok(!bad.length, bad.slice(0, 5).join('; '));
  });
  await check(`[${theme}] contrast >= 4.5:1 (3:1 large) for all text on all pages`, async () => {
    const all = [];
    for (const [nm, h] of PAGES) {
      await go(p, h, nm);
      if (nm === 'stats') { await p.locator('.chart-wrap [data-hit]').nth(3).hover({ force: true }).catch(() => {}); await p.waitForTimeout(200); }
      if (nm === 'workflow') { await p.locator('button', { hasText: /Versions/ }).first().click().catch(() => {}); await p.waitForTimeout(200); }
      const r = await contrast(p);
      if (r.bad.length) all.push(`${nm}(${r.n}): ${r.bad.slice(0, 6).join(' | ')}`);
      else notes.push(`${theme} ${nm}: ${r.n} text elements all pass`);
      const at = await p.evaluate(() => window.__attr); if (at) notes.push(`${theme} ${nm}: xyflow attribution link ratio ${at} (third-party, exempt from the check)`);
    }
    ok(!all.length, all.join(' || '));
  });
  await ctx.close();
}

// ---------- three dark blocks in sync (computed): system dark == forced dark; system light == forced light
await check('three theme blocks in sync: system-dark computed vars equal forced-dark vars (and light equal)', async () => {
  const snap = async (theme, scheme) => { const { ctx, p } = await newPage(theme, 1200, 800, scheme); await p.goto(`${base}/#/`); await p.waitForTimeout(500); const names = await p.evaluate(allVarNames); const v = await p.evaluate(readVars, names); const attr = await p.evaluate(() => document.documentElement.getAttribute('data-theme')); await ctx.close(); return { v, attr, names }; };
  const sysDark = await snap('system', 'dark'), forcedDark = await snap('dark', 'dark');
  ok(sysDark.attr === null && forcedDark.attr === 'dark', `attrs ${sysDark.attr}/${forcedDark.attr}`);
  const dd = Object.keys(forcedDark.v).filter((k) => sysDark.v[k] !== forcedDark.v[k]);
  ok(!dd.length, 'dark blocks differ: ' + dd.map((k) => `${k}: ${sysDark.v[k]} vs ${forcedDark.v[k]}`).join('; '));
  const sysLight = await snap('system', 'light'), forcedLight = await snap('light', 'light');
  const dl = Object.keys(forcedLight.v).filter((k) => sysLight.v[k] !== forcedLight.v[k]);
  ok(!dl.length, 'light differs: ' + dl.join(','));
  // every custom property declared is defined in both themes
  // --ui-* / --aui-* belong to the vendored affectUI pieces and are set on their own roots, not on <html>.
  const un = forcedDark.names.filter((n) => !forcedDark.v[n] || !forcedLight.v[n]).filter((n) => !/^--(xy|tc$|rs$|ui-|aui-)/.test(n));
  ok(!un.length, 'declared but empty in a theme: ' + un.join(','));
  ok(JSON.stringify(sysDark.v) !== JSON.stringify(sysLight.v), 'dark equals light');
});
await check('theme: default is dark even when the system is light; toggle cycles dark -> light -> system -> dark and applies', async () => {
  const { ctx, p } = await newPage('default', 1200, 800, 'light');
  await p.goto(`${base}/#/`); await p.waitForTimeout(400);
  const first = await p.evaluate(() => document.documentElement.getAttribute('data-theme'));
  const label = async () => (await p.getByRole('button', { name: /^Theme:/ }).innerText()).trim();
  const labels = [await label()];
  const attrs = [];
  for (let i = 0; i < 3; i++) { await p.getByRole('button', { name: /^Theme:/ }).click(); await p.waitForTimeout(150); attrs.push(await p.evaluate(() => document.documentElement.getAttribute('data-theme'))); labels.push(await label()); }
  await ctx.close();
  ok(first === 'dark', `default theme attr ${first}`);
  ok(JSON.stringify(labels) === JSON.stringify(['Dark', 'Light', 'System', 'Dark']), JSON.stringify(labels));
  ok(JSON.stringify(attrs) === JSON.stringify(['light', null, 'dark']), JSON.stringify(attrs));
});

// ---------- 390 px layouts, both themes, all pages
for (const theme of ['light', 'dark']) {
  await check(`[${theme}] 390 px: no horizontal scroll on any page`, async () => {
    const { ctx, p } = await newPage(theme, 390, 800);
    const bad = [];
    for (const [nm, h] of PAGES) {
      await go(p, h, nm);
      if (nm === 'workflow' || nm.startsWith('run-')) continue; // full-bleed editor/run view are fixed-grid by design; measured below
      const r = await p.evaluate(() => ({ d: document.documentElement.scrollWidth - document.documentElement.clientWidth, m: [...document.querySelectorAll('main')].map((m) => m.scrollWidth - m.clientWidth)[0] || 0 }));
      if (r.d > 0 || r.m > 0) { bad.push(`${nm} doc+${r.d} main+${r.m}`); notes.push('overflow culprits ' + JSON.stringify(await p.evaluate(() => { const m = document.querySelector('main'); const out = []; for (const e of m.querySelectorAll('*')) { const r = e.getBoundingClientRect(); if (r.right > m.getBoundingClientRect().right + 0.5) out.push(e.tagName + '.' + e.className + ' right=' + Math.round(r.right) + ' w=' + Math.round(r.width)); } return { mw: m.clientWidth, msw: m.scrollWidth, out: out.slice(0, 8) }; }))); }
    }
    await p.screenshot({ path: path.join(SHOTS, `mobile-stats-${theme}.png`) });
    await ctx.close();
    ok(!bad.length, bad.join('; '));
  });
}
await check('390 px: editor and run view page itself does not scroll horizontally (document level) - informational compare with base', async () => {
  const { ctx, p } = await newPage('light', 390, 800);
  const out = [];
  for (const [nm, h] of PAGES.filter(([n]) => n === 'workflow' || n.startsWith('run-'))) { await go(p, h, nm); out.push(`${nm}:${await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)}`); }
  await ctx.close();
  notes.push('390 editor/run doc overflow: ' + out.join(' '));
});

// ---------- network: no external requests; the only font request is the self-hosted Inter file
await check('no external network requests and no font request other than the bundled Inter while visiting every page', async () => {
  const origin = new URL(base).origin;
  const ext = requests.filter(([u]) => !u.startsWith(origin) && !/^(data|blob|about):/.test(u));
  const fonts = requests.filter(([u, t]) => t === 'font' && !(u.startsWith(origin) && /\/assets\/InterVariable-[\w-]+\.woff2$/.test(u)));
  ok(requests.length > 20, 'few requests recorded: ' + requests.length);
  ok(!ext.length, 'external: ' + ext.slice(0, 3).map((x) => x[0]).join(', '));
  ok(!fonts.length, 'font requests: ' + fonts.slice(0, 3).map((x) => x[0]).join(', '));
});

// screenshots of every page, both themes (for Gate 2, not asserted)
for (const theme of ['light', 'dark']) {
  const { ctx, p } = await newPage(theme);
  for (const [nm, h] of PAGES) { try { await go(p, h, nm); await p.screenshot({ path: path.join(SHOTS, `${nm}-${theme}.png`) }); } catch (e) { notes.push('shot ' + nm + ' ' + e.message.split('\n')[0]); } }
  await ctx.close();
}

await browser.close();
try { await mcp.client.close(); } catch { /* */ }
await srv.close();
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
for (const [n, s, d] of results) console.log(`${s}  ${n}${d ? '  -> ' + d : ''}`);
for (const n of notes) console.log('NOTE ' + n);
console.log(`${results.filter((r) => r[1] === 'PASS').length}/${results.length} passed; shots in ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
