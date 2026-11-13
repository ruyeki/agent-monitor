// Holdout e2e: waiting section on Monitor, no Waiting tab, full-width cards, run view card, 390 px, screenshots.
// Run: WEB_DIR=<temp build> CHROME_PATH=<chrome> [HV_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-waiting.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = process.env.HV_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-hv-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a temp build'); process.exit(2); }

const results = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); }
  catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 220)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const mcp = await mcpClient(app.url);
const start = async (title) => runIdOf((await mcp.call('start_run', { title })).text);

const LONG = [
  '[CloudLab] T10.10 template requests: a new table, or a new type in the existing requests table?',
  'Background: Rohit settled the process. Chemical requests live in `requests` and are approved by an admin before any lab work starts.',
  'Proposal: a new template_requests table, reusing the Requests page and notification plumbing. Backend PR first, then the admin and client screens.',
  'Options: A = new table (recommended) / B = new type in requests',
  'Answer: Resume with A or B, or Stop run.',
].join('\n');

const plain = await start('Plain gate run');
await mcp.call('complete_stage', { run: plain, stage: 'frame', outcome: 'pass' });
const plain2 = await start('Second plain run');
await mcp.call('complete_stage', { run: plain2, stage: 'frame', outcome: 'pass' });
const long = await start('Escalated long ask');
const esc = await mcp.call('escalate', { run: long, question: LONG });
const busy = await start('Busy active run');
const stoppedRun = await start('Finished run');
await app.api('POST', `/api/runs/${stoppedRun}/stop`, { body: {} });
const runsNow = (await app.api('GET', '/api/runs')).json;
const statusOf = (id) => runsNow.find((r) => r.id === id)?.status;

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1300, height: 900 }, colorScheme: 'light' });
page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const tabLabel = async () => (await page.locator('main h2', { hasText: /^Waiting on you/ }).first().innerText()).trim();

await check('seed: three runs are waiting, the long ask is intact', async () => {
  ok(esc && !esc.isError, `escalate failed: ${esc?.text}`);
  ok([plain, plain2, long].every((id) => statusOf(id) === 'waiting'), `not all waiting: ${[plain, plain2, long].map(statusOf)}`);
  ok(statusOf(busy) !== 'waiting', 'busy run should not be waiting');
  const ask = runsNow.find((r) => r.id === long).ask || '';
  ok(ask.includes('\nBackground:'), 'long ask lost its newlines');
});

await page.goto(`${base}/#/`);
await page.locator('nav[aria-label="Sections"]').waitFor();

await check('nav: Monitor, Workflow, Stats in order; no Waiting tab', async () => {
  await until(async () => (await tabLabel()) === 'Waiting on you (3)', 5000);
  const labels = await page.locator('nav[aria-label="Sections"] a').allInnerTexts();
  ok(labels.map((s) => s.trim()).join(',') === 'Monitor,Workflow,Stats', `nav was ${labels.join(',')}`);
});

await check('monitor: waiting section with 3 cards above the Runs heading, in its own panel; no waiting rows', async () => {
  ok((await page.locator('main').getByRole('article').count()) === 3, 'expected 3 waiting cards on Monitor');
  ok((await page.getByRole('row', { name: /Plain gate run|Second plain run|Escalated long ask/ }).count()) === 0, 'a waiting run row is in the Runs table');
  ok((await page.getByRole('row', { name: /Busy active run/ }).count()) === 1, 'active run row missing');
  ok((await page.getByRole('link', { name: /waiting on you/ }).count()) === 0, 'old waiting link is still there');
  const wh = await page.locator('main h2', { hasText: /^Waiting on you/ }).boundingBox();
  const rh = await page.getByRole('heading', { name: /^Runs \(/ }).boundingBox();
  ok(wh && rh && wh.y < rh.y, 'waiting heading is not above the Runs heading');
  const sep = await page.evaluate(() => {
    const sec = [...document.querySelectorAll('main section')].find((x) => /^Waiting on you/.test(x.querySelector('h2')?.textContent || ''));
    const panel = sec.parentElement;
    const cs = getComputedStyle(panel);
    const mainBg = getComputedStyle(document.querySelector('main')).backgroundColor;
    const bodyBg = getComputedStyle(document.body).backgroundColor;
    const visible = (cs.backgroundColor !== mainBg && cs.backgroundColor !== bodyBg && cs.backgroundColor !== 'rgba(0, 0, 0, 0)')
      || parseFloat(cs.borderTopWidth) > 0;
    const runsH = [...document.querySelectorAll('main h2')].find((h) => /^Runs \(/.test(h.textContent));
    return { isMain: panel.tagName === 'MAIN', visible, hasRuns: panel.contains(runsH), bottom: panel.getBoundingClientRect().bottom, runsTop: runsH.getBoundingClientRect().top };
  });
  ok(!sep.isMain && !sep.hasRuns, 'waiting section has no panel of its own');
  ok(sep.visible, 'the waiting panel has neither a different background nor a border');
  ok(sep.runsTop - sep.bottom >= 4, `panel and Runs heading are not apart (${Math.round(sep.runsTop - sep.bottom)} px)`);
  const body = await page.locator('main').innerText();
  ok(/Finished runs \(1\)/.test(body), 'finished section changed');
});

async function shots(name, hash, vp) {
  for (const scheme of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize(vp);
    await page.goto(`${base}/${hash}`);
    await page.locator('main').waitFor();
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(SHOTS, `${name}-${scheme}.png`), fullPage: true });
  }
  await page.emulateMedia({ colorScheme: 'light' });
}
await check('screenshots: monitor light and dark, monitor at 390 px', async () => {
  await shots('monitor', '#/', { width: 1300, height: 1000 });
  await shots('monitor-mobile', '#/', { width: 390, height: 844 });
  await page.setViewportSize({ width: 1300, height: 900 });
});

await page.goto(`${base}/#/waiting`);
await check('#/waiting shows Monitor: Monitor is current, three cards and the Runs table', async () => {
  await page.getByRole('article').first().waitFor({ timeout: 5000 });
  ok((await page.getByRole('article').count()) === 3, 'expected 3 cards');
  ok((await page.locator('nav[aria-label="Sections"] a[aria-current="page"]').innerText()).trim() === 'Monitor', 'aria-current on Monitor');
  ok((await page.getByRole('heading', { name: /^Runs \(/ }).count()) === 1, 'Runs heading missing on #/waiting');
});

await page.goto(`${base}/#/`);

await check('cards: full width, one per row', async () => {
  const main = await page.locator('main').boundingBox();
  const boxes = [];
  for (const c of await page.getByRole('article').all()) boxes.push(await c.boundingBox());
  ok(boxes.length === 3, 'expected 3 cards on Monitor');
  for (const b of boxes) ok(b.width >= main.width * 0.9, `card ${Math.round(b.width)} px of main ${Math.round(main.width)} px`);
  for (let i = 1; i < boxes.length; i++) ok(boxes[i].y >= boxes[i - 1].y + boxes[i - 1].height - 1, 'cards are not stacked one per row');
});

await check('long ask card is formatted: heading, four rows, code element, no raw backticks', async () => {
  const card = page.getByRole('article', { name: /Escalated long ask/ });
  ok((await card.locator('h4.ask-heading').innerText()).startsWith('[CloudLab] T10.10 template requests'), 'heading');
  ok((await card.locator('.ask-row').count()) === 4, 'expected 4 rows');
  ok((await card.locator('.ask-label').allInnerTexts()).join(',') === 'Background,Proposal,Options,Answer', 'labels');
  ok((await card.locator('.ask code').innerText()) === 'requests', 'code element');
  ok(!(await card.locator('.ask').innerText()).includes('`'), 'raw backtick shown');
  const w = async (sel) => (await card.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontWeight)));
  ok((await w('.ask-label')) > (await w('.ask-text')), 'label should be heavier than text');
  const lb = await card.locator('.ask-label').first().boundingBox();
  const tb = await card.locator('.ask-text').first().boundingBox();
  ok(tb.x > lb.x + 20, 'on a wide card the label sits in its own column left of the text');
});

await check('one-line ask card: heading only', async () => {
  const card = page.getByRole('article', { name: /Plain gate run/ });
  ok((await card.locator('.ask-row, .ask-para').count()) === 0, 'extra blocks on a one-line ask');
  ok(/solution/i.test(await card.locator('h4.ask-heading').innerText()), 'heading text');
});

await check('run view: card has the same formatting, label above text in the side panel', async () => {
  await page.goto(`${base}/#/runs/${long}`);
  const card = page.locator('.run-side').getByRole('article').first();
  await card.waitFor({ timeout: 6000 });
  ok((await card.locator('h4.ask-heading').count()) === 1, 'heading');
  ok((await card.locator('.ask-row').count()) === 4, 'rows');
  const lb = await card.locator('.ask-label').first().boundingBox();
  const tb = await card.locator('.ask-text').first().boundingBox();
  ok(tb.y >= lb.y + lb.height - 1, 'in the side panel the label should sit above the text');
  const sw = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  ok(sw, 'run view scrolls sideways');
});

await check('390 px: no sideways scroll on #/waiting and #/, all three tabs reachable', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ['#/waiting', '#/']) {
    await page.goto(`${base}/${h}`);
    await page.locator('main').waitFor();
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
    ok(m.s <= m.c + 1, `${h} scrolls sideways (${m.s} > ${m.c})`);
  }
  for (const a of await page.locator('nav[aria-label="Sections"] a').all()) {
    const b = await a.boundingBox();
    ok(b && b.x >= 0 && b.x + b.width <= 391, 'a tab is cut off at 390 px');
  }
  await page.setViewportSize({ width: 1300, height: 900 });
});

await check('live: count drops on the Monitor page without reload after the run is answered elsewhere', async () => {
  await page.goto(`${base}/#/`);
  ok(await until(async () => (await tabLabel()) === 'Waiting on you (3)', 5000), 'start count');
  await page.evaluate(() => { window.__marker = 1; });
  const r = await app.api('POST', `/api/runs/${plain2}/respond`, { body: { action: 'Agree spec', text: '' } });
  ok(r.status === 200, `respond ${r.status} ${r.text}`);
  ok(await until(async () => (await tabLabel()) === 'Waiting on you (2)', 6000), `heading stayed ${await tabLabel()}`);
  ok(await page.evaluate(() => window.__marker === 1), 'page reloaded instead of updating live');
  ok(await page.locator('main').getByRole('article').count() === 2, 'cards did not update');
});

await check('answering from the card removes it and lowers the count', async () => {
  await page.goto(`${base}/#/`);
  const card = page.getByRole('article', { name: /Waiting on you: Plain gate run/ });
  await card.waitFor({ timeout: 5000 });
  await card.getByRole('textbox').fill('agreed');
  await card.getByRole('button', { name: /agree spec/i }).click();
  await card.waitFor({ state: 'detached', timeout: 6000 });
  ok(await until(async () => (await tabLabel()) === 'Waiting on you (1)', 5000), `heading ${await tabLabel()}`);
});

await check('empty state after everything is answered', async () => {
  const card = page.getByRole('article', { name: /Escalated long ask/ });
  await card.getByRole('button', { name: /stop run/i }).click().catch(() => {});
  ok(await until(async () => (await page.getByText('Nothing is waiting on you.').count()) === 1, 6000), 'empty text missing');
  ok((await tabLabel()) === 'Waiting on you (0)', 'count not zero');
  ok((await page.getByRole('heading', { name: /^Runs \(/ }).count()) === 1, 'Runs heading gone');
});

ok(true, '');
results.push(['no uncaught page errors', pageErrors.length ? 'FAIL' : 'PASS', pageErrors.slice(0, 2).join(' | ').slice(0, 200)]);

await browser.close();
await app.srv.close?.();
let failed = 0;
for (const [n, s, m] of results) { if (s !== 'PASS') failed++; console.log(`${s}  ${n}${m ? `  -- ${m}` : ''}`); }
console.log(`${results.length - failed}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
