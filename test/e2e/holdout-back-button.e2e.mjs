// Holdout e2e (am-back-button): real browser history, reload, keyboard, light/dark, 1440 and 390, on the built bundle.
// Run: WEB_DIR=<build> CHROME_PATH=<chrome> [HV_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-back-button.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = process.env.HV_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-back-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a build'); process.exit(2); }

const results = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 260)]);
    try { await page?.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const mcp = await mcpClient(app.url);
const start = async (t) => runIdOf((await mcp.call('start_run', { title: t })).text);
const wait1 = await start('Alpha gate run');
await mcp.call('complete_stage', { run: wait1, stage: 'frame', outcome: 'pass' });
const busy = await start('Delta busy run');
const fin = await start('Zeta finished run');
await app.api('POST', `/api/runs/${fin}/stop`, { body: {} });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function open(hash = '#/', { scheme = 'light', w = 1440, h = 900 } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* ignore */ } }, scheme);
  const p = await ctx.newPage();
  await p.goto(`${base}/${hash}`);
  await p.locator('main').waitFor();
  return { ctx, p };
}
const backBtn = (p) => p.getByRole('button', { name: 'Back', exact: true });
const hashOf = (p) => p.evaluate(() => window.location.hash);
const isPlain = (h) => ['', '#', '#/'].includes(h);
const h1 = async (p) => (await p.locator('main h1').first().innerText()).trim();
const view = (p, n) => p.locator('nav[aria-label="Views"]').getByRole('button', { name: new RegExp(`^${n}`) });
const settle = (p) => p.waitForTimeout(350);
const goto = async (p, hash) => { await p.evaluate((x) => { window.location.hash = x; }, hash); await settle(p); };
const clickBack = async (p) => { await backBtn(p).click(); await settle(p); };
const sidebarLink = async (p, name) => { await p.locator('nav[aria-label="Sections"]').getByRole('link', { name }).click(); await settle(p); };
const search = (p) => p.getByRole('searchbox', { name: 'Search runs' });

await check('plain Monitor has no Back button', async () => {
  const { ctx, p } = await open(); page = p;
  ok((await backBtn(p).count()) === 0, 'Back shown on the plain Monitor');
  await ctx.close();
});

await check('views are in the URL: click writes ?view=, reload keeps the view, Back button present', async () => {
  const { ctx, p } = await open(); page = p;
  await view(p, 'Needs you').click(); await settle(p);
  ok((await hashOf(p)) === '#/?view=waiting', `hash ${await hashOf(p)}`);
  await p.reload(); await p.locator('main').waitFor(); await settle(p);
  ok((await h1(p)) === 'Needs you', `h1 after reload ${await h1(p)}`);
  ok((await view(p, 'Needs you').getAttribute('aria-pressed')) === 'true', 'view not pressed after reload');
  ok((await backBtn(p).count()) === 1, 'no Back on the view');
  await ctx.close();
});

await check('browser Back/Forward step through views', async () => {
  const { ctx, p } = await open(); page = p;
  await view(p, 'Needs you').click(); await settle(p);
  await view(p, 'Running').click(); await settle(p);
  ok((await h1(p)) === 'Running', 'not on Running');
  await p.goBack(); await settle(p);
  ok((await h1(p)) === 'Needs you', `after goBack ${await h1(p)}`);
  await p.goBack(); await settle(p);
  ok((await h1(p)) === 'Monitor' && (await backBtn(p).count()) === 0, 'not the plain Monitor after second goBack');
  await p.goForward(); await settle(p);
  ok((await h1(p)) === 'Needs you', `after goForward ${await h1(p)}`);
  await ctx.close();
});

await check('Back on a view (and search) returns to the plain Monitor with the search cleared', async () => {
  const { ctx, p } = await open(); page = p;
  await view(p, 'Running').click(); await settle(p);
  await search(p).fill('Delta'); await settle(p);
  await clickBack(p);
  ok((await h1(p)) === 'Monitor', `h1 ${await h1(p)}`);
  ok(isPlain(await hashOf(p)), `hash ${await hashOf(p)}`);
  ok((await search(p).inputValue()) === '', 'search not cleared');
  ok((await view(p, 'Running').getAttribute('aria-pressed')) === 'false', 'view still pressed');
  ok((await backBtn(p).count()) === 0, 'Back still shown on the plain Monitor');
  await ctx.close();
});

await check('search alone on the Monitor shows Back; Back clears the search', async () => {
  const { ctx, p } = await open(); page = p;
  await search(p).fill('Delta'); await settle(p);
  ok((await backBtn(p).count()) === 1, 'no Back while a search is typed');
  await clickBack(p);
  ok((await search(p).inputValue()) === '', 'search not cleared');
  ok((await backBtn(p).count()) === 0, 'Back still shown');
  await ctx.close();
});

await check('#/waiting (old link) lands on the full Monitor without Back', async () => {
  const { ctx, p } = await open('#/waiting'); page = p;
  ok((await h1(p)) === 'Monitor' && (await backBtn(p).count()) === 0, `h1 ${await h1(p)}`);
  await ctx.close();
});

await check('run opened from the Monitor: tab switches are skipped, Back returns to the Monitor', async () => {
  const { ctx, p } = await open(); page = p;
  await p.locator(`a[href^="#/runs/${busy}"]`).first().click(); await settle(p);
  for (const tab of ['Ledger', 'Crew', 'Stages']) {
    const t = p.getByRole('tab', { name: new RegExp(`^${tab}`) });
    if (await t.count()) { await t.first().click(); await settle(p); }
  }
  ok((await hashOf(p)).startsWith(`#/runs/${busy}`), `not on the run: ${await hashOf(p)}`);
  await clickBack(p);
  ok(isPlain(await hashOf(p)) && (await h1(p)) === 'Monitor', `landed on ${await hashOf(p)}`);
  await ctx.close();
});

await check('run opened from a view: Back returns to that same view', async () => {
  const { ctx, p } = await open(); page = p;
  await view(p, 'Running').click(); await settle(p);
  await p.locator(`a[href^="#/runs/${busy}"]`).first().click(); await settle(p);
  await goto(p, `#/runs/${busy}/ledger`);
  await goto(p, `#/runs/${busy}/crew`);
  await clickBack(p);
  ok((await hashOf(p)) === '#/?view=active', `landed on ${await hashOf(p)}`);
  ok((await h1(p)) === 'Running', 'view not restored');
  await ctx.close();
});

await check('run deep link with tab switches: Back goes to the Monitor, not a previous tab', async () => {
  const { ctx, p } = await open(`#/runs/${busy}/crew`); page = p;
  await goto(p, `#/runs/${busy}/ledger`);
  await goto(p, `#/runs/${busy}/stages`);
  await clickBack(p);
  ok(isPlain(await hashOf(p)), `landed on ${await hashOf(p)}`);
  ok((await h1(p)) === 'Monitor', `h1 ${await h1(p)}`);
  await ctx.close();
});

await check('Stats from the Monitor: Back returns to the Monitor; Workflow after Stats: Back returns to Stats', async () => {
  const { ctx, p } = await open(); page = p;
  await sidebarLink(p, 'Stats');
  ok((await h1(p)) === 'Stats', 'not on Stats');
  await sidebarLink(p, 'Workflow');
  await clickBack(p);
  ok((await hashOf(p)) === '#/stats', `after Workflow Back: ${await hashOf(p)}`);
  await clickBack(p);
  ok(isPlain(await hashOf(p)), `after Stats Back: ${await hashOf(p)}`);
  await ctx.close();
});

await check('Accounts, Workflow and Stats opened directly: Back goes to the Monitor', async () => {
  for (const h of ['#/accounts', '#/workflow', '#/stats']) {
    const { ctx, p } = await open(h); page = p;
    ok((await backBtn(p).count()) === 1, `no Back on ${h}`);
    await clickBack(p);
    ok(isPlain(await hashOf(p)), `${h} -> ${await hashOf(p)}`);
    await ctx.close();
  }
});

await check('Back works from the keyboard (Tab to it, Enter) and shows a focus outline', async () => {
  const { ctx, p } = await open('#/stats'); page = p;
  const onBack = () => p.evaluate(() => /^Back$/.test((document.activeElement?.textContent || '').trim()));
  let n = 0;
  do { await p.keyboard.press('Tab'); } while (n++ < 30 && !(await onBack()));
  ok(await onBack(), 'Back never received keyboard focus');
  const outline = await p.evaluate(() => { const s = getComputedStyle(document.activeElement); return `${s.outlineStyle}|${s.outlineWidth}`; });
  ok(!/^none/.test(outline) && !/\|0px$/.test(outline), `no visible focus ring: ${outline}`);
  await p.keyboard.press('Enter'); await settle(p);
  ok(isPlain(await hashOf(p)), `Enter did not go back: ${await hashOf(p)}`);
  await ctx.close();
});

await check('Back sits at the top-left of the header, before the title', async () => {
  for (const h of ['#/stats', '#/accounts', '#/workflow', `#/runs/${busy}`, '#/?view=finished']) {
    const { ctx, p } = await open(h); page = p;
    await backBtn(p).waitFor({ timeout: 4000 });
    const r = await p.evaluate(() => {
      const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Back').getBoundingClientRect();
      const t = document.querySelector('main h1').getBoundingClientRect();
      const head = document.querySelector('main .page-head').getBoundingClientRect();
      return { bx: b.left, by: b.top, tx: t.left, ty: t.top, hx: head.left, hy: head.top };
    });
    ok(r.bx < r.tx || r.by < r.ty - 1, `${h}: Back not before the title (${JSON.stringify(r)})`);
    ok(r.bx - r.hx < 120 && r.by - r.hy < 80, `${h}: Back not at the top-left of the header (${JSON.stringify(r)})`);
    await ctx.close();
  }
});

for (const scheme of ['light', 'dark']) for (const w of [1440, 390]) {
  await check(`${scheme} ${w}px: Back visible, readable, no horizontal overflow on every page`, async () => {
    const { ctx, p } = await open('#/', { scheme, w, h: w === 390 ? 844 : 900 }); page = p;
    for (const [h, tag] of [['#/?view=waiting', 'needs-you'], ['#/?view=active', 'running'], ['#/?view=finished', 'finished'], [`#/runs/${busy}/crew`, 'run'], ['#/stats', 'stats'], ['#/accounts', 'accounts'], ['#/workflow', 'workflow']]) {
      await goto(p, h); await p.waitForTimeout(250);
      const b = backBtn(p);
      ok((await b.count()) === 1 && (await b.isVisible()), `${h}: Back not visible`);
      const o = await p.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      ok(o.sw <= o.cw + 1, `${h}: horizontal overflow ${o.sw} > ${o.cw}`);
      const c = await b.evaluate((el) => {
        const lum = (rgb) => { const [r, g, bl] = rgb.match(/[\d.]+/g).map(Number).slice(0, 3).map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * bl; };
        let bg = el; let col = getComputedStyle(el).backgroundColor;
        while (/, 0\)$|transparent/.test(col) && bg.parentElement) { bg = bg.parentElement; col = getComputedStyle(bg).backgroundColor; }
        const a = lum(getComputedStyle(el).color); const z = lum(col);
        return (Math.max(a, z) + 0.05) / (Math.min(a, z) + 0.05);
      });
      ok(c >= 3, `${h}: Back text contrast ${c.toFixed(2)} < 3`);
      if (['needs-you', 'run', 'stats'].includes(tag)) await p.screenshot({ path: path.join(SHOTS, `${tag}-${w}-${scheme}.png`) });
    }
    await ctx.close();
  });
}

await check('only one control named "Back"; no "Back to monitor" text; breadcrumb kept, on the run page', async () => {
  const { ctx, p } = await open(`#/runs/${busy}`); page = p;
  await backBtn(p).waitFor({ timeout: 4000 });
  ok((await backBtn(p).count()) === 1, 'more than one Back');
  ok((await p.getByText(/back to monitor/i).count()) === 0, '"Back to monitor" text present');
  ok((await p.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Monitor' }).count()) === 1, 'breadcrumb lost');
  await ctx.close();
});

await browser.close();
await app.srv.close?.();
let bad = 0;
for (const [n, s, m] of results) { if (s !== 'PASS') bad++; console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`); }
console.log(`\n${results.length - bad}/${results.length} passed; shots in ${SHOTS}`);
process.exit(bad ? 1 : 0);
