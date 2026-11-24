// Holdout e2e (am-inbox-open): the decision inbox shows every question open, side by side, full width, above the run list.
// Run: WEB_DIR=<copy of the build> CHROME_PATH=<chrome> [HV_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-inbox-open.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = process.env.HV_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-inbox-open-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a build'); process.exit(2); }

const results = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 260)]);
    try { await page?.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`), fullPage: true }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const LONG = [
  '[CloudLab] T10.10 template requests: a new table, or a new type in the existing requests table?',
  'Background: Chemical requests live in `requests` and are approved by an admin before any lab work starts.',
  'Proposal: a new template_requests table, reusing the Requests page and notification plumbing.',
  'Options: A = new table (recommended) / B = new type in requests',
].join('\n');

// ---------- server 1: three waiting runs, one running, one finished
const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const mcp = await mcpClient(app.url);
const start = async (t) => runIdOf((await mcp.call('start_run', { title: t })).text);
const A = await start('Alpha gate run'); await mcp.call('complete_stage', { run: A, stage: 'frame', outcome: 'pass' });
await new Promise((r) => setTimeout(r, 80));
const B = await start('Beta gate run'); await mcp.call('complete_stage', { run: B, stage: 'frame', outcome: 'pass' });
await new Promise((r) => setTimeout(r, 80));
const C = await start('Gamma long ask'); await mcp.call('escalate', { run: C, question: LONG });
await start('Delta busy run');
const F = await start('Epsilon finished run'); await app.api('POST', `/api/runs/${F}/stop`, { body: {} });
const runs = () => app.api('GET', '/api/runs').then((r) => r.json);
ok((await runs()).filter((r) => r.status === 'waiting').length === 3, 'seed: three runs should be waiting');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function newPage(w, h, scheme = 'light', origin = base) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* ignore */ } }, scheme);
  const p = await ctx.newPage();
  await p.goto(`${origin}/#/`);
  await p.locator('main').waitFor();
  return { ctx, p };
}
const pane = (p) => p.locator('aside.inbox-pane[aria-label="Decision inbox"]');
const cards = (p) => pane(p).locator('article');
const boxes = (p) => cards(p).evaluateAll((as) => as.map((a) => { const r = a.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height, id: a.getAttribute('data-run-id') }; }));
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

// ---------- 1440 px
let ctx1, p1;
({ ctx1, p1 } = await (async () => { const { ctx, p } = await newPage(1440, 900, 'light'); return { ctx1: ctx, p1: p }; })());
page = p1;
await until(async () => (await cards(p1).count()) === 3, 6000);

await check('every question is open: no folded title buttons, no inert bodies, title + ask + actions + Open run on each', async () => {
  ok((await cards(p1).count()) === 3, 'expected three cards');
  ok((await pane(p1).locator('button.ui-dic__title--folded').count()) === 0, 'a folded title button is present');
  ok((await pane(p1).locator('[inert]').count()) === 0, 'an inert element is present');
  for (let i = 0; i < 3; i++) {
    const c = cards(p1).nth(i);
    ok((await c.locator('h3.ui-dic__title').isVisible()), `card ${i} title not visible`);
    ok((await c.locator('.ask-heading, .ask').first().isVisible()), `card ${i} ask not visible`);
    ok((await c.locator('.ui-dic__actions button').first().isVisible()), `card ${i} actions not visible`);
    ok((await c.locator('a.open-run').isVisible()), `card ${i} Open run not visible`);
  }
});

await check('1440px: the three cards share one row (same top, different left, no overlap) with gaps; each has its own surface', async () => {
  const b = await boxes(p1);
  const row = b.filter((x) => near(x.t, b[0].t, 3));
  const wide = (await pane(p1).boundingBox()).width;
  ok(row.length >= 2, `only ${row.length} card(s) in the first row`);
  if (wide >= 1100) ok(row.length === 3, `${row.length} in first row at aside width ${Math.round(wide)}`);
  const ls = row.map((x) => x.l);
  ok(new Set(ls.map((l) => Math.round(l))).size === row.length, `lefts not distinct: ${ls}`);
  for (let i = 1; i < row.length; i++) ok(row[i].l >= row[i - 1].l + row[i - 1].w + 4, `cards touch or overlap: ${JSON.stringify(row)}`);
  ok(b.every((x) => x.w >= 300), `a card is narrower than 300px: ${b.map((x) => Math.round(x.w))}`);
  const surf = await cards(p1).evaluateAll((as) => as.map((a) => { const s = getComputedStyle(a); return { sh: s.boxShadow, bg: s.backgroundColor, r: s.borderTopLeftRadius }; }));
  ok(surf.every((s) => s.sh !== 'none' && !/rgba\(0, 0, 0, 0\)|transparent/.test(s.bg) && parseFloat(s.r) > 0), `cards lack own surface: ${JSON.stringify(surf)}`);
});

await check('1440px: the inbox is full width above the run list; the run list is full width below', async () => {
  const strip = await p1.locator('section.stat-strip').boundingBox();
  const ib = await pane(p1).boundingBox();
  const lb = await p1.locator('section.run-list').boundingBox();
  ok(ib.y + ib.height <= strip.y + 1, 'the inbox is not above the KPI strip (a waiting question comes first)');
  ok(ib.y + ib.height <= lb.y + 1, `inbox (bottom ${Math.round(ib.y + ib.height)}) is not above the run list (top ${Math.round(lb.y)})`);
  ok(ib.width >= strip.width * 0.93, `inbox ${Math.round(ib.width)}px is not full width (strip ${Math.round(strip.width)}px)`);
  ok(lb.width >= strip.width * 0.93, `run list ${Math.round(lb.width)}px is not full width (strip ${Math.round(strip.width)}px)`);
  const b = await boxes(p1);
  ok(Math.max(...b.map((x) => x.l + x.w)) <= ib.x + ib.width + 1, 'a card sticks out of the inbox');
});

await check('1440px: no sideways scroll; note has no "next one opens"', async () => {
  ok(await p1.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1), 'page scrolls sideways');
  const t = await pane(p1).innerText();
  ok(!/next one opens/i.test(t), 'the note still says the next one opens');
});

await check('keyboard: Tab through the inbox never lands on a hidden, zero-size or inert control', async () => {
  await cards(p1).first().locator('.ui-dic__actions button').first().focus();
  for (let i = 0; i < 22; i++) {
    await p1.keyboard.press('Tab');
    const s = await p1.evaluate(() => { const e = document.activeElement; const r = e.getBoundingClientRect(); const st = getComputedStyle(e); return { inert: !!e.closest('[inert],[hidden]'), w: r.width, h: r.height, vis: st.visibility, disp: st.display, tag: e.tagName }; });
    ok(!s.inert && s.w > 0 && s.h > 0 && s.vis !== 'hidden' && s.disp !== 'none', `Tab ${i}: ${JSON.stringify(s)}`);
  }
});

await check('screenshots: list view with three waiting runs at 1440px, light and dark', async () => {
  for (const scheme of ['light', 'dark']) {
    const { ctx, p } = await newPage(1440, 1000, scheme);
    await cards(p).first().waitFor();
    await p.waitForTimeout(500);
    await p.screenshot({ path: path.join(SHOTS, `list-1440-${scheme}.png`), fullPage: true });
    await ctx.close();
  }
});

await check('view=waiting (Needs you): same grid, full width, no run list', async () => {
  await p1.goto(`${base}/#/`);
  await p1.locator('nav[aria-label="Views"]').getByRole('button', { name: /^Needs you/ }).click();
  await p1.waitForTimeout(400);
  ok((await p1.locator('section.run-list').count()) === 0, 'run list is shown in the Needs you view');
  const b = await boxes(p1);
  ok(b.length === 3, `${b.length} cards`);
  const row = b.filter((x) => near(x.t, b[0].t, 3));
  ok(row.length >= 2 && new Set(row.map((x) => Math.round(x.l))).size === row.length, `cards do not share a row: ${JSON.stringify(b)}`);
  const ib = await pane(p1).boundingBox();
  const main = await p1.locator('main').boundingBox();
  ok(ib.width >= main.width * 0.85, `inbox ${Math.round(ib.width)}px of main ${Math.round(main.width)}px (capped?)`);
  ok((await pane(p1).locator('button.ui-dic__title--folded, [inert]').count()) === 0, 'folded or inert content in the Needs you view');
});

await check('answering the FIRST card folds only it; the others stay open and close the gap; focus moves to the next open card', async () => {
  await p1.goto(`${base}/#/`);
  await until(async () => (await cards(p1).count()) === 3, 5000);
  const before = await boxes(p1);
  const first = cards(p1).first();
  await first.locator('textarea').first().fill('keep this? no, answered').catch(() => {});
  await cards(p1).nth(2).locator('textarea').first().fill('third reply kept').catch(() => {});
  await first.locator('.ui-dic__actions button').last().click();
  await first.getByRole('button', { name: 'Confirm' }).click(); // the last action is "Stop run": it ends the run, so it asks to confirm first
  await first.locator('.ui-dic__done').waitFor({ timeout: 4000 });
  ok((await pane(p1).locator('h2').innerText()).trim() === '2 need your input', 'count did not drop to 2');
  await p1.waitForTimeout(2600);
  const visible = [];
  for (let i = 0; i < await cards(p1).count(); i++) { const c = cards(p1).nth(i); if (await c.isVisible()) visible.push(c); }
  ok(visible.length === 2, `${visible.length} visible cards after the fold (answered card should be gone, others kept)`);
  for (const c of visible) ok((await c.locator('h3.ui-dic__title').isVisible()) && (await c.locator('.ui-dic__actions button').first().isVisible()), 'a remaining card is not open');
  const after = await boxes(p1).then((bs) => bs.filter((x) => x.h > 0 && x.w > 0));
  const vis = after.filter((x) => x.id !== before[0].id && x.h > 20);
  ok(vis.length === 2 && near(vis[0].t, vis[1].t, 3), `remaining cards do not share a row: ${JSON.stringify(vis)}`);
  ok(near(Math.min(...vis.map((x) => x.l)), before[0].l, 4), `the gap was not closed: first remaining card left ${Math.round(Math.min(...vis.map((x) => x.l)))} vs old first column ${Math.round(before[0].l)}`);
  ok(await visible[visible.length - 1].locator('textarea').first().inputValue().then((v) => v === 'third reply kept').catch(() => true), 'reply text of another card was lost');
  const foc = await p1.evaluate(() => { const e = document.activeElement; const a = e?.closest('article'); return { inInbox: !!e?.closest('aside[aria-label="Decision inbox"]'), art: a?.getAttribute('data-run-id') || null, inert: !!e?.closest('[inert]') }; });
  ok(foc.inInbox && foc.art && foc.art !== before[0].id && !foc.inert, `focus after the fold: ${JSON.stringify(foc)}`);
});

await check('answering the remaining cards ends in the compact All caught up state, focus on the heading', async () => {
  for (let n = 0; n < 2; n++) {
    let c = null;
    for (let i = 0; i < await cards(p1).count(); i++) { const x = cards(p1).nth(i); if (await x.isVisible() && await x.locator('.ui-dic__actions button').count() && !(await x.locator('.ui-dic__done').count())) { c = x; break; } }
    ok(c, 'no open card to answer');
    await c.locator('.ui-dic__actions button').last().click();
    await c.getByRole('button', { name: 'Confirm' }).click(); // Stop run asks to confirm
    await c.locator('.ui-dic__done').waitFor({ timeout: 4000 });
    await p1.waitForTimeout(1900);
  }
  await until(async () => /All caught up/.test(await pane(p1).locator('h2').innerText()), 4000);
  ok(/All caught up/.test(await pane(p1).locator('h2').innerText()), 'heading is not All caught up');
  await p1.waitForTimeout(800);
  const hb = await pane(p1).boundingBox();
  ok(hb.height <= 56, `all-clear inbox is ${Math.round(hb.height)}px tall`);
});
await ctx1.close();

// ---------- 390 px
await check('390px: one card per row (same left, increasing top), inbox above the run list, no sideways scroll, in both themes', async () => {
  for (const scheme of ['light', 'dark']) {
    // fresh server state is gone (answered above), so seed three new waiting runs
    const ids = [];
    for (const t of [`Phone one ${scheme}`, `Phone two ${scheme}`, `Phone three ${scheme}`]) { const id = await start(t); await mcp.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' }); ids.push(id); }
    const { ctx, p } = await newPage(390, 844, scheme);
    page = p;
    await until(async () => (await cards(p).count()) >= 3, 6000);
    await p.waitForTimeout(400);
    const b = (await boxes(p)).filter((x) => x.h > 20);
    ok(b.length >= 3, `${b.length} cards`);
    ok(b.every((x) => near(x.l, b[0].l, 2)), `cards not in one column: ${JSON.stringify(b.map((x) => Math.round(x.l)))}`);
    for (let i = 1; i < b.length; i++) ok(b[i].t > b[i - 1].t + b[i - 1].h - 1, 'cards overlap vertically');
    ok(b.every((x) => x.w >= 300 && x.l >= 0 && x.l + x.w <= 391), `card width/position off: ${JSON.stringify(b.map((x) => [Math.round(x.l), Math.round(x.w)]))}`);
    const ib = await pane(p).boundingBox();
    const lb = await p.locator('section.run-list').boundingBox();
    ok(ib.y + ib.height <= lb.y + 1, 'inbox is not above the run list at 390px');
    ok(await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1 && document.querySelector('main').scrollWidth <= document.querySelector('main').clientWidth + 1), 'sideways scroll at 390px');
    ok((await pane(p).locator('button.ui-dic__title--folded, [inert]').count()) === 0, 'folded or inert content at 390px');
    await p.screenshot({ path: path.join(SHOTS, `list-390-${scheme}.png`), fullPage: true });
    await ctx.close();
    for (const id of ids) await app.api('POST', `/api/runs/${id}/stop`, { body: {} });
  }
});
await app.srv.close?.();

// ---------- server 3: the LAST answered card keeps its place during the confirmation and fold
const app3 = await boot({ webDir });
const mcp3 = await mcpClient(app3.url);
for (const t of ['Last-card one', 'Last-card two']) { const id = runIdOf((await mcp3.call('start_run', { title: t })).text); await mcp3.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' }); await new Promise((r) => setTimeout(r, 80)); }
await check('1440px: answering the LAST card keeps it in its grid cell while the confirmation shows; then the aside is one compact line', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agent-monitor-theme', 'light'); } catch { /* ignore */ } });
  const p = await ctx.newPage(); page = p;
  await p.goto(`${app3.url.replace(/\/$/, '')}/#/`);
  await until(async () => (await cards(p).count()) === 2, 6000);
  await cards(p).first().locator('.ui-dic__actions button').last().click();
  await cards(p).first().getByRole('button', { name: 'Confirm' }).click(); // Stop run asks to confirm
  await cards(p).first().locator('.ui-dic__done').waitFor({ timeout: 4000 });
  await p.waitForTimeout(2200);
  let left = null;
  for (let i = 0; i < await cards(p).count(); i++) { const c = cards(p).nth(i); if (await c.isVisible()) left = c; }
  ok(left, 'no visible card left after the first fold');
  const before = await left.boundingBox();
  const paneBefore = await pane(p).boundingBox();
  await left.locator('.ui-dic__actions button').last().click();
  await left.getByRole('button', { name: 'Confirm' }).click(); // Stop run asks to confirm
  await left.locator('.ui-dic__done').waitFor({ timeout: 4000 });
  await p.waitForTimeout(300);
  const mid = await left.boundingBox();
  const paneMid = await pane(p).boundingBox();
  // once nothing waits the KPI strip moves back above the inbox, so the whole aside shifts down: the card must stay put inside the aside
  ok(mid && near(mid.x, before.x, 2) && near(mid.y - paneMid.y, before.y - paneBefore.y, 2), `last card moved while confirming: ${JSON.stringify({ before, mid, paneBefore, paneMid })}`);
  ok(mid.height > 40, `last card collapsed while confirming (${Math.round(mid.height)}px)`);
  await p.waitForTimeout(2200);
  await until(async () => /All caught up/.test(await pane(p).locator('h2').innerText()), 4000);
  const ab = await pane(p).boundingBox();
  ok(ab.height <= 56, `aside is ${Math.round(ab.height)}px tall after the fold`);
  await ctx.close();
});
await app3.srv.close?.();

// ---------- server 2: nothing waiting
const app2 = await boot({ webDir });
const mcp2 = await mcpClient(app2.url);
await mcp2.call('start_run', { title: 'Only a busy run' });
await check('nothing waiting: compact one-line All caught up (aside <= 56px at 1440px), no cards, no note', async () => {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  await ctx.addInitScript(() => { try { localStorage.setItem('agent-monitor-theme', 'light'); } catch { /* ignore */ } });
  const p = await ctx.newPage(); page = p;
  await p.goto(`${app2.url.replace(/\/$/, '')}/#/`);
  await pane(p).waitFor();
  await p.waitForTimeout(500);
  ok(/All caught up/.test(await pane(p).locator('h2').innerText()), 'heading');
  ok(/Nothing is waiting on you\./.test(await pane(p).innerText()), 'empty text');
  ok((await cards(p).count()) === 0, 'cards in the empty state');
  const ab = await pane(p).boundingBox();
  ok(ab.height <= 56, `aside is ${Math.round(ab.height)}px tall`);
  const h = await pane(p).locator('h2').boundingBox();
  const e = await pane(p).getByText('Nothing is waiting on you.').boundingBox();
  ok(Math.abs((h.y + h.height / 2) - (e.y + e.height / 2)) < 14, 'heading and "Nothing is waiting on you." are not on one line');
  ok((await p.locator('.inbox-note').count()) === 0, 'note shown with nothing waiting');
  await p.screenshot({ path: path.join(SHOTS, 'empty-1440-light.png'), fullPage: true });
  await ctx.close();
});

await browser.close();
await app2.srv.close?.();
let bad = 0;
for (const [n, s, m] of results) { if (s !== 'PASS') bad++; console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`); }
console.log(`\n${results.length - bad}/${results.length} passed; shots in ${SHOTS}`);
process.exit(bad ? 1 : 0);
