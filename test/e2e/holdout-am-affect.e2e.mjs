// Holdout e2e (#2288): Decision Inbox, Tool calls, Thinking pill in a real browser on a built bundle: theme (4 modes), contrast, reduced motion, keyboard, live refresh, 390 px, screenshots.
// Run: WEB_DIR=<built dist> CHROME_PATH=<chromium> [AM_AFFECT_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-am-affect.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { load, tmp, until, sleep, mcpClient, runIdOf, hook, req, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
const SHOTS = process.env.AM_AFFECT_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-affect-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a build'); process.exit(2); }

const results = [];
const notes = [];
const pageErrors = [];
const requests = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 300)]);
    try { await page?.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

// ---------- seed
const projects = tmp('am-affect-proj-');
fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
const { startServer } = await load('src/server.js');
const srv = await startServer({ port: 0, dataDir: tmp('am-affect-home-'), projectsDir: projects, webDir });
const base = srv.url.replace(/\/$/, '');
const get = async (p) => (await req(srv.port, 'GET', p)).json;
const mcp = await mcpClient(srv.url);
const call = async (name, args) => (await mcp.call(name, args)).text;
const tp = (s) => path.join(projects, 'proj', `${s}.jsonl`);
const H = (s, ev, extra = {}) => hook(srv.port, { hook_event_name: ev, session_id: s, transcript_path: tp(s), cwd: '/x', ...extra });
const link = (s, id) => H(s, 'PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: id }, tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame) · round 0/5 · status active` }] } });
const pre = (s, id, tool, input) => H(s, 'PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id });
const post = (s, id, tool) => H(s, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: { ok: true }, tool_use_id: id });
const fail = (s, id, tool, error) => H(s, 'PostToolUseFailure', { tool_name: tool, tool_input: {}, tool_use_id: id, error });

const waiters = [];
for (const [t, ageMs] of [['Alpha migration', 0], ['Beta cleanup', 60], ['Gamma rollout', 120]]) {
  const id = runIdOf(await call('start_run', { title: t }));
  await call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
  waiters.push(id);
  await sleep(60);
}
ok((await get('/api/runs')).filter((r) => r.status === 'waiting').length === 3, 'three runs should be waiting');

// run with ok, error and no-end (stopped) calls
const RT = runIdOf(await call('start_run', { title: 'Tool call run' }));
await link('s-tools', RT);
await pre('s-tools', 'k1', 'Bash', { command: 'npm run build && echo a-very-long-command-line-that-needs-to-wrap-in-the-body-of-the-card' });
await post('s-tools', 'k1', 'Bash');
await pre('s-tools', 'k2', 'Read', { file_path: '/repo/src/file.js' });
await fail('s-tools', 'k2', 'Read', 'ENOENT: no such file');
await pre('s-tools', 'k3', 'Edit', { file_path: '/repo/src/x.js' });
await H('s-tools', 'Stop');
// run with an open call (running + pill)
const RR = runIdOf(await call('start_run', { title: 'Running run' }));
await link('s-run', RR);
await pre('s-run', 'r1', 'Bash', { command: 'sleep 600' });
await sleep(300);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function newPage({ theme = 'dark', scheme, width = 1300, height = 900, reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: scheme || (theme === 'dark' ? 'dark' : 'light'), reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* */ } }, theme);
  ctx.setDefaultTimeout(5000);
  const p = await ctx.newPage();
  p.on('request', (r) => requests.push(r.url()));
  p.on('pageerror', (e) => pageErrors.push(String(e)));
  return { ctx, p };
}
const openMonitor = async (p) => { await p.goto(`${base}/#/`); await p.locator('aside[aria-label="Decision inbox"] article').first().waitFor({ timeout: 10000 }); await p.waitForTimeout(400); };
const openRun = async (p, id) => { await p.goto(`${base}/#/runs/${id}`); await p.locator('section[aria-label="Tool calls"]').waitFor({ timeout: 10000 }); await p.waitForTimeout(400); };

const helpers = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  window.__rgba = rgba;
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  window.__lum = lum;
  window.__ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  window.__bgOf = (el) => { const chain = []; for (let e = el; e; e = e.parentElement) chain.push(e); let bg = [255, 255, 255, 1]; for (const e of chain.reverse()) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg); } return bg; };
  window.__opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  window.__token = (name) => { const d = document.createElement('div'); d.style.color = `var(${name})`; document.body.appendChild(d); const c = getComputedStyle(d).color; d.remove(); return rgba(c); };
};
// Text contrast of everything inside the given root selectors (vendored components), skipping hidden and inert parts.
async function contrast(p, roots) {
  await p.evaluate(helpers);
  return p.evaluate((sel) => {
    const bad = []; let n = 0;
    for (const root of document.querySelectorAll(sel)) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        if (el.closest('.sr-only, .ui-tclc-sr')) continue;
        const cs = getComputedStyle(el);
        if (cs.visibility === 'hidden' || cs.display === 'none') continue;
        let text = '';
        const field = ['INPUT', 'TEXTAREA'].includes(el.tagName);
        for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
        if (field) text = (el.value || '') + (el.getAttribute('placeholder') || '');
        if (!text.trim()) continue;
        if (el.closest('[inert]') || el.matches(':disabled')) continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (field && !el.value) { /* placeholder colour is checked through ::placeholder below */ continue; }
        const bg = window.__bgOf(el);
        let fg = window.__rgba(el instanceof SVGElement ? cs.fill : cs.color);
        fg[3] *= window.__opacity(el);
        const eff = fg[3] < 1 ? [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1] : fg;
        const size = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10);
        const large = size >= 24 || (size >= 18.66 && w >= 700);
        const ratio = window.__ratio(eff, bg); n++;
        if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').split(' ')[0]} "${text.trim().slice(0, 22)}" ${ratio.toFixed(2)}`);
      }
    }
    return { n, bad };
  }, roots);
}
const MODES = [
  ['light', { theme: 'light', scheme: 'light' }],
  ['dark (data-theme)', { theme: 'dark', scheme: 'dark' }],
  ['OS dark, no data-theme', { theme: 'system', scheme: 'dark' }],
  ['data-theme light under OS dark', { theme: 'light', scheme: 'dark' }],
];

// ---------- theme: vendored components follow AM tokens in all modes
for (const [label, opt] of MODES) {
  await check(`[${label}] inbox, tool calls and pill colours follow the AM tokens and text contrast is >= 4.5:1`, async () => {
    const { ctx, p } = await newPage(opt);
    page = p;
    await openMonitor(p);
    await p.evaluate(helpers);
    const expectDark = opt.scheme === 'dark' ? opt.theme !== 'light' : opt.theme === 'dark';
    const mon = await p.evaluate(() => {
      const tok = window.__token; const px = (el, prop) => window.__rgba(getComputedStyle(el)[prop]);
      const root = document.querySelector('.ui-dic__row'); // each question is its own surface card
      const prim = document.querySelector('.ui-dic__btn--primary');
      const title = document.querySelector('.ui-dic__title');
      const rgb = (c) => c.slice(0, 3).map(Math.round).join(',');
      return {
        rootBg: rgb(window.__bgOf(root)), surface: rgb(tok('--surface')), lum: window.__lum(window.__bgOf(root)),
        primBg: rgb(window.__bgOf(prim)), accent: rgb(tok('--accent')), primFg: rgb(px(prim, 'color')), accentText: rgb(tok('--accent-text')),
        titleFg: rgb(px(title, 'color')), text: rgb(tok('--text')),
      };
    });
    ok(mon.rootBg === mon.surface, `inbox background ${mon.rootBg} != --surface ${mon.surface}`);
    ok(mon.primBg === mon.accent && mon.primFg === mon.accentText, `primary button ${mon.primBg}/${mon.primFg} vs accent ${mon.accent}/${mon.accentText}`);
    ok(mon.titleFg === mon.text, `title colour ${mon.titleFg} != --text ${mon.text}`);
    ok(expectDark ? mon.lum < 0.15 : mon.lum > 0.7, `inbox surface luminance ${mon.lum.toFixed(2)} wrong for ${label}`);
    const c1 = await contrast(p, '.ui-dic');
    ok(c1.n > 5 && c1.bad.length === 0, `inbox contrast (${c1.n} texts): ${c1.bad.slice(0, 4).join('; ')}`);
    // every item is open now: no folded line is left to open
    ok(await p.locator('.ui-dic__title--folded').count() === 0, 'a folded line is still there');
    // hover the primary button: it must stay the accent family, never the light-grey global button hover
    await p.locator('.ui-dic__btn--primary').first().hover(); await p.waitForTimeout(250);
    const hov = await p.evaluate(() => { const b = document.querySelector('.ui-dic__btn--primary:hover') || document.querySelector('.ui-dic__btn--primary'); const bg = window.__rgba(getComputedStyle(b).backgroundColor); const ac = window.__token('--accent'); return { d: Math.abs(bg[0] - ac[0]) + Math.abs(bg[1] - ac[1]) + Math.abs(bg[2] - ac[2]), hovered: !!document.querySelector('.ui-dic__btn--primary:hover') }; });
    ok(hov.d < 120, `primary hover colour drifted from accent (${hov.d})`);
    await openRun(p, RT);
    const c2 = await contrast(p, 'section[aria-label="Tool calls"]');
    ok(c2.n > 5 && c2.bad.length === 0, `tool calls contrast (${c2.n} texts): ${c2.bad.slice(0, 4).join('; ')}`);
    await p.locator('section[aria-label="Tool calls"] button.ui-tclc__head').nth(1).click(); await p.waitForTimeout(450);
    const c2b = await contrast(p, 'section[aria-label="Tool calls"]');
    ok(c2b.bad.length === 0, `expanded tool call contrast: ${c2b.bad.slice(0, 4).join('; ')}`);
    const card = await p.evaluate(() => { const c = document.querySelector('section[aria-label="Tool calls"] .ui-tclc'); const rgb = (x) => x.slice(0, 3).map(Math.round).join(','); return { bg: rgb(window.__bgOf(c)), surface: rgb(window.__token('--surface')), name: rgb(window.__rgba(getComputedStyle(document.querySelector('.ui-tclc__name')).color)) }; });
    ok(card.bg === card.surface, `tool call card background ${card.bg} != --surface ${card.surface}`);
    await openRun(p, RR);
    const c3 = await contrast(p, 'section[aria-label="Active agents"]');
    ok(c3.bad.length === 0, `thinking pill contrast: ${c3.bad.slice(0, 4).join('; ')}`);
    ok(await p.locator('section[aria-label="Active agents"] .ui-tlc').count() === 1, 'pill missing on the running run');
    await ctx.close();
  });
}

// ---------- reduced motion
await check('reduced motion: nothing runs an infinite animation on the Monitor, the tool-call run or the run with a pill; no-preference does animate', async () => {
  const { ctx, p } = await newPage({ theme: 'dark', reduced: true });
  page = p;
  const inf = () => p.evaluate(() => document.getAnimations().filter((a) => a.playState === 'running').map((a) => ({ n: a.animationName || a.constructor.name, it: a.effect?.getComputedTiming().iterations, dur: a.effect?.getComputedTiming().duration })).filter((x) => x.it === Infinity));
  await openMonitor(p); await p.waitForTimeout(800);
  let a = await inf(); ok(a.length === 0, `Monitor infinite animations: ${JSON.stringify(a)}`);
  await openRun(p, RT); await p.waitForTimeout(800);
  a = await inf(); ok(a.length === 0, `tool-call run infinite animations: ${JSON.stringify(a)}`);
  await openRun(p, RR); await p.waitForTimeout(1200);
  ok(await p.locator('.ui-tlc').count() === 1 && await p.locator('.ui-tclc[data-status="running"]').count() >= 1, 'running run lacks pill/running card');
  a = await inf(); ok(a.length === 0, `running run infinite animations: ${JSON.stringify(a)}`);
  const css = await p.evaluate(() => { const s = document.querySelector('.ui-tclc__spinner'); return s ? getComputedStyle(s).animationIterationCount : 'none'; });
  ok(css !== 'infinite', `spinner animation-iteration-count ${css}`);
  await ctx.close();
  const { ctx: c2, p: p2 } = await newPage({ theme: 'dark', reduced: false });
  page = p2;
  await openRun(p2, RR); await p2.waitForTimeout(500);
  const n = await p2.evaluate(() => document.getAnimations().length);
  notes.push(`no-preference run view animations: ${n}`);
  await c2.close();
});

// ---------- inbox behaviour in the browser
await check('inbox: oldest first, all open; every action offered; answering confirms, folds, the others stay open and the run leaves waiting', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  page = p;
  await openMonitor(p);
  const arts = p.locator('aside[aria-label="Decision inbox"] article');
  ok(await arts.count() === 3, `${await arts.count()} items`);
  const ids = await arts.evaluateAll((a) => a.map((x) => x.getAttribute('data-run-id')));
  ok(JSON.stringify(ids) === JSON.stringify(waiters), `order ${ids} vs ${waiters}`);
  ok(await p.getByRole('heading', { level: 2, name: '3 need your input' }).count() === 1, 'header count');
  ok(await p.locator('section[aria-label="Runs"]').getByText('Alpha migration').count() === 0, 'waiting run is also listed in the run list');
  const first = p.locator('article[data-run-id="' + waiters[0] + '"]');
  const labels = await first.locator('.ui-dic__actions button').allInnerTexts();
  const gate = (await get(`/api/runs/${waiters[0]}`)).run.actions.map((a) => a.label);
  ok(JSON.stringify(labels.filter((l) => gate.includes(l.trim())).map((l) => l.trim())) === JSON.stringify(gate), `actions ${labels} vs ${gate}`);
  ok(await first.locator('a.open-run').getAttribute('href') === `#/runs/${waiters[0]}`, 'Open run link');
  // keyboard: Tab never lands inside an inert element
  await p.locator('aside[aria-label="Decision inbox"] textarea').first().focus();
  const seen = [];
  for (let i = 0; i < 14; i++) { await p.keyboard.press('Tab'); seen.push(await p.evaluate(() => { const e = document.activeElement; return { inert: !!e?.closest('[inert]'), inInbox: !!e?.closest('aside[aria-label="Decision inbox"]'), t: (e?.textContent || e?.tagName || '').slice(0, 20) }; })); }
  ok(seen.every((s) => !s.inert), `focus reached an inert element: ${JSON.stringify(seen.filter((s) => s.inert))}`);
  // answer the first
  await p.locator('article[data-run-id="' + waiters[0] + '"] textarea').fill('go');
  await first.locator('.ui-dic__actions button').filter({ hasText: gate[0] }).first().click();
  await p.locator('article[data-run-id="' + waiters[0] + '"] .ui-dic__done').waitFor({ timeout: 4000 });
  ok(await p.getByRole('heading', { level: 2, name: '2 need your input' }).count() === 1, 'count did not drop');
  await until(async () => (await get(`/api/runs/${waiters[0]}`)).run.status !== 'waiting', 4000, 100);
  await p.waitForTimeout(2200);
  ok(await p.locator('article[data-run-id="' + waiters[0] + '"]').count() === 0 || await p.locator('article[data-run-id="' + waiters[0] + '"]').evaluate((e) => !!e.closest('[data-gone],[inert]')), 'answered row still reachable');
  const second = p.locator('article[data-run-id="' + waiters[1] + '"]');
  ok(await second.locator('.ui-dic__actions button').first().isVisible(), 'the other item is not open');
  ok(await p.evaluate(() => !!document.activeElement?.closest('aside[aria-label="Decision inbox"]')), 'focus left the inbox');
  await ctx.close();
});

await check('inbox: a refresh while another item is being read does not fold it or lose the typed reply', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  page = p;
  await openMonitor(p);
  const target = p.locator('article[data-run-id="' + waiters[2] + '"]');
  await target.locator('textarea').fill('typing a draft');
  const rn = runIdOf(await call('start_run', { title: 'Noise run ' + Date.now() })); // an SSE event that refreshes the list
  await until(async () => (await p.locator('section[aria-label="Runs"]').getByText('Noise run').count()) > 0, 5000, 100);
  ok(await target.locator('textarea').inputValue() === 'typing a draft', 'draft lost on refresh');
  ok(await target.locator('textarea').isVisible(), 'item folded on refresh');
  await call('complete_stage', { run: rn, stage: 'frame', outcome: 'done' }); // becomes a new waiting item
  await until(async () => (await p.locator('aside[aria-label="Decision inbox"] article').count()) === 3, 5000, 100);
  ok(await target.locator('textarea').inputValue() === 'typing a draft', 'draft lost when a new item arrived');
  await ctx.close();
});

// ---------- tool calls and pill in the browser
await check('a run whose agent was stopped does not show a running call or a pill (Stop after an open call)', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  page = p;
  await openRun(p, RT);
  ok(await p.locator('.ui-tclc[data-status="running"]').count() === 0, 'running card on a stopped turn');
  ok(await p.locator('section[aria-label="Active agents"] .ui-tlc').count() === 0, 'pill on a stopped turn');
  await ctx.close();
});

await check('tool calls: ok / failed / no end recorded / running states, expand, survive a live refresh, no jump from the timer', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  page = p;
  await openRun(p, RT);
  const cards = p.locator('section[aria-label="Tool calls"] .ui-tclc');
  const st = await cards.evaluateAll((a) => a.map((x) => [x.getAttribute('data-status'), x.querySelector('.ui-tclc__name')?.textContent]));
  ok(JSON.stringify(st) === JSON.stringify([['unknown', 'Edit'], ['error', 'Read'], ['success', 'Bash']]), JSON.stringify(st));
  ok(await cards.nth(0).locator('.ui-tclc__spinner').count() === 0, 'unknown call shows a spinner');
  ok((await cards.nth(0).innerText()).includes('No end recorded') || await cards.nth(0).locator('[title="No end recorded"]').count() > 0, 'no "No end recorded"');
  await cards.nth(1).locator('button.ui-tclc__head').click();
  await p.waitForTimeout(500);
  const body = await cards.nth(1).locator('.ui-tclc__body').innerText();
  ok(/ENOENT/.test(body), `error text missing: ${body}`);
  // live refresh: a new call arrives, the expanded card stays open
  await pre('s-tools', 'k9', 'Grep', { pattern: 'x' });
  await until(async () => (await p.locator('section[aria-label="Tool calls"] .ui-tclc').count()) === 4, 6000, 100);
  const exp = await p.locator('section[aria-label="Tool calls"] .ui-tclc').evaluateAll((a) => a.map((x) => x.querySelector('button.ui-tclc__head').getAttribute('aria-expanded')));
  ok(exp[2] === 'true' && exp.filter((e) => e === 'true').length === 1, `expanded state after refresh: ${exp}`);
  await ctx.close();
  const { ctx: c2, p: p2 } = await newPage({ theme: 'dark' });
  page = p2;
  await openRun(p2, RR);
  const card = p2.locator('section[aria-label="Tool calls"] .ui-tclc[data-status="running"]').first();
  ok(await card.count() === 1, 'running card missing');
  const timer = card.locator('.ui-tclc__time');
  const w1 = (await timer.boundingBox()).width; const t1 = await timer.innerText();
  await p2.waitForTimeout(2300);
  const w2 = (await timer.boundingBox()).width; const t2 = await timer.innerText();
  ok(t1 !== t2, `timer did not tick (${t1} -> ${t2})`);
  ok(Math.abs(w1 - w2) < 0.6, `timer width changed ${w1} -> ${w2}`);
  const pill = p2.locator('section[aria-label="Active agents"] .ui-tlc');
  ok((await pill.innerText()).includes('Bash'), 'pill not labelled with the running tool');
  ok(await p2.locator('section[aria-label="Active agents"] [aria-live], section[aria-label="Tool calls"] [aria-live]').count() === 0, 'aria-live inside the run side');
  // the pill and the running card go away when the call ends
  await post('s-run', 'r1', 'Bash');
  await until(async () => (await p2.locator('.ui-tclc[data-status="running"]').count()) === 0, 6000, 100);
  ok(await p2.locator('.ui-tclc[data-status="success"]').count() === 1, 'card did not turn to success');
  await c2.close();
});

// ---------- 390 px and screenshots
for (const [label, opt] of [['light', { theme: 'light' }], ['dark', { theme: 'dark' }]]) {
  await check(`[${label}] 390 px: no sideways scroll on Monitor and run view; screenshots`, async () => {
    const { ctx, p } = await newPage({ ...opt, width: 390, height: 800 });
    page = p;
    await openMonitor(p);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'Monitor scrolls sideways');
    ok(await p.evaluate(() => [...document.querySelectorAll('.ui-dic *')].every((e) => e.getBoundingClientRect().right <= window.innerWidth + 1 || e.closest('[inert]'))), 'inbox content wider than the screen');
    await p.screenshot({ path: path.join(SHOTS, `monitor-${label}-390.png`), fullPage: true });
    await openRun(p, RT);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'run view scrolls sideways');
    await p.locator('section[aria-label="Tool calls"] button.ui-tclc__head').first().click(); await p.waitForTimeout(450);
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'expanded tool call scrolls sideways');
    await p.screenshot({ path: path.join(SHOTS, `run-${label}-390.png`), fullPage: true });
    await ctx.close();
  });
}
for (const [label, opt] of [['light', { theme: 'light' }], ['dark', { theme: 'dark' }]]) {
  await check(`[${label}] desktop screenshots of the Monitor inbox and the run view`, async () => {
    const { ctx, p } = await newPage({ ...opt, width: 1300, height: 900 });
    page = p;
    await openMonitor(p);
    await p.screenshot({ path: path.join(SHOTS, `monitor-${label}.png`), fullPage: true });
    await openRun(p, RR);
    await p.locator('section[aria-label="Tool calls"] button.ui-tclc__head').first().click(); await p.waitForTimeout(450);
    await p.screenshot({ path: path.join(SHOTS, `run-running-${label}.png`), fullPage: true });
    await openRun(p, RT);
    await p.locator('section[aria-label="Tool calls"] button.ui-tclc__head').nth(1).click(); await p.waitForTimeout(450);
    await p.screenshot({ path: path.join(SHOTS, `run-calls-${label}.png`), fullPage: true });
    await ctx.close();
  });
}

await check('other pages are unchanged: Stats and Workflow render no vendored component and no page error', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  page = p;
  await p.goto(`${base}/#/stats`); await p.locator('.stats-page .panel').first().waitFor({ timeout: 10000 });
  ok(await p.locator('[class*="ui-dic"], [class*="ui-tclc"], [class*="ui-tlc"]').count() === 0, 'vendored markup on Stats');
  await p.goto(`${base}/#/workflow`); await p.locator('.fnode[data-node="frame"]').waitFor({ timeout: 10000 });
  ok(await p.locator('[class*="ui-dic"], [class*="ui-tclc"], [class*="ui-tlc"]').count() === 0, 'vendored markup on Workflow');
  await ctx.close();
});

await check('no external requests, no page errors', async () => {
  const ext = [...new Set(requests.filter((u) => !/^(data:|blob:|about:)/.test(u) && !u.startsWith(base)))];
  ok(ext.length === 0, `external requests: ${ext.slice(0, 4).join(' ')}`);
  ok(pageErrors.length === 0, pageErrors.slice(0, 2).join(' ; '));
});

await browser.close();
try { await mcp.client.close(); } catch { /* ignore */ }
await srv.close();
console.log('\nRESULTS');
for (const [nm, s, m] of results) console.log(`${s.padEnd(5)} ${nm}${m ? '  -> ' + m : ''}`);
for (const x of notes) console.log('NOTE ' + x);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r.length && r[1] === 'FAIL') ? 1 : 0);
