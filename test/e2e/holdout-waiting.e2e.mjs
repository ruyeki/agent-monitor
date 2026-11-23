// Holdout e2e: waiting runs in the Monitor (decision inbox), formatted asks, run view card, 390 px, screenshots.
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
// The app defaults to dark; 'system' lets the emulated colour scheme apply.
await ctx.addInitScript(() => { try { localStorage.setItem('agent-monitor-theme', 'system'); } catch { /* ignore */ } });
page = await ctx.newPage();
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));

const views = () => page.locator('nav[aria-label="Views"]');
const waitingView = () => views().getByRole('button', { name: /^Needs you/ });
const waitingCount = async () => ((await waitingView().innerText()).match(/\d+/) || [''])[0];
const pane = () => page.getByRole('complementary', { name: 'Decision inbox' });
const itemOf = (title) => pane().locator(`article[aria-label="Waiting on you: ${title}"]`);
// Opens a folded inbox item (a no-op when it is already open).
const openItem = async (title) => {
  const it = itemOf(title);
  await it.waitFor({ timeout: 5000 });
  if (await it.locator('button.ui-dic__title--folded').count()) await it.locator('button.ui-dic__title--folded').click();
  await it.locator('h3.ui-dic__title').waitFor({ timeout: 5000 });
};

await check('seed: three runs are waiting, the long ask is intact', async () => {
  ok(esc && !esc.isError, `escalate failed: ${esc?.text}`);
  ok([plain, plain2, long].every((id) => statusOf(id) === 'waiting'), `not all waiting: ${[plain, plain2, long].map(statusOf)}`);
  ok(statusOf(busy) !== 'waiting', 'busy run should not be waiting');
  const ask = runsNow.find((r) => r.id === long).ask || '';
  ok(ask.includes('\nBackground:'), 'long ask lost its newlines');
});

await page.goto(`${base}/#/`);
await page.locator('nav[aria-label="Sections"]').waitFor();

await check('nav: Monitor, Workflow, Stats in order (no Waiting page); Views count 3', async () => {
  await until(async () => (await waitingCount()) === '3', 5000);
  const links = page.locator('nav[aria-label="Sections"] a');
  const labels = (await links.allInnerTexts()).map((t) => t.trim().replace(/\d+$/, '').trim());
  ok(labels.join(',') === 'Monitor,Workflow,Stats', `nav was ${labels.join(',')}`);
  const hrefs = await links.evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  ok(hrefs.join(',') === '#/,#/workflow,#/stats', `hrefs ${hrefs}`);
  ok((await page.locator('nav[aria-label="Sections"] a[aria-current="page"]').innerText()).startsWith('Monitor'), 'aria-current on Monitor');
  ok((await page.locator('nav[aria-label="Sections"] a', { hasText: /^Monitor/ }).locator('.nav-count').innerText()).trim() === '4', 'open count (3 waiting + 1 active)');
});

await check('monitor: no waiting group; the inbox holds three items (oldest open), active row, Finished group', async () => {
  ok((await page.locator('section[aria-labelledby="group-waiting"]').count()) === 0, 'the Waiting on you group is still in the run list');
  ok((await page.locator('section[aria-labelledby="group-active"]').getByRole('link', { name: /Busy active run/ }).count()) === 1, 'active run row missing');
  ok(/Finished\s*1/.test(await page.locator('#group-finished').innerText()), 'finished group changed');
  ok((await page.locator('article').count()) === 3, 'expected three items, all in the inbox');
  ok((await pane().locator('article').count()) === 3, 'the items are not in the decision inbox');
  ok((await pane().locator('h2').innerText()).trim() === '3 need your input', `heading ${await pane().locator('h2').innerText()}`);
  const first = pane().locator('article').first();
  ok((await first.getAttribute('aria-label')) === 'Waiting on you: Plain gate run', `first item ${await first.getAttribute('aria-label')}`);
  ok((await first.locator('a.open-run').innerText()).trim() === 'Open run →', 'Open run link missing');
  ok((await pane().locator('article button.ui-dic__title--folded').count()) === 2, 'the other two items should be folded');
  ok((await page.getByRole('table').count()) === 0, 'a table is on the Monitor page');
});

await check('#/waiting lands on the Monitor', async () => {
  await page.goto(`${base}/#/waiting`);
  await page.locator('section.run-list').waitFor({ timeout: 5000 });
  ok((await page.getByRole('heading', { level: 1 }).innerText()).trim() === 'Monitor', 'not on the Monitor');
  ok((await page.locator('nav[aria-label="Sections"] a[aria-current="page"]').innerText()).startsWith('Monitor'), 'aria-current');
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
await check('screenshots: monitor with the decision inbox, light and dark', async () => {
  await shots('monitor', '#/', { width: 1300, height: 900 });
  await shots('monitor-mobile', '#/', { width: 390, height: 844 });
  await page.setViewportSize({ width: 1300, height: 900 });
});

await page.goto(`${base}/#/`);
await check('inbox card fills the pane width; each item fills the card', async () => {
  await pane().locator('article').first().waitFor({ timeout: 5000 });
  const p = await pane().boundingBox();
  const c = await pane().locator('.ui-dic').boundingBox();
  const b = await pane().locator('article').first().boundingBox();
  ok(c.width >= p.width * 0.85, `card ${Math.round(c.width)} px of pane ${Math.round(p.width)} px`);
  ok(Math.abs(b.width - c.width) < 2, `item ${Math.round(b.width)} px of card ${Math.round(c.width)} px`);
});

await check('long ask card is formatted: heading, four rows, code element, no raw backticks', async () => {
  await openItem('Escalated long ask');
  const card = itemOf('Escalated long ask');
  ok((await card.locator('h4.ask-heading').innerText()).startsWith('[CloudLab] T10.10 template requests'), 'heading');
  ok((await card.locator('.ask-row').count()) === 4, 'expected 4 rows');
  ok((await card.locator('.ask-label').allInnerTexts()).join(',') === 'Background,Proposal,Options,Answer', 'labels');
  ok((await card.locator('.ask code').innerText()) === 'requests', 'code element');
  ok(!(await card.locator('.ask').innerText()).includes('`'), 'raw backtick shown');
  const w = async (sel) => (await card.locator(sel).first().evaluate((e) => parseFloat(getComputedStyle(e).fontWeight)));
  ok((await w('.ask-label')) > (await w('.ask-text')), 'label should be heavier than text');
  const lb = await card.locator('.ask-label').first().boundingBox();
  const tb = await card.locator('.ask-text').first().boundingBox();
  ok(tb.x > lb.x + 20, 'on a wide screen the label sits in its own column left of the text in the answer pane');
});

await check('one-line ask card: heading only', async () => {
  await openItem('Plain gate run');
  const card = itemOf('Plain gate run');
  ok((await card.locator('.ask-row, .ask-para').count()) === 0, 'extra blocks on a one-line ask');
  ok(/solution/i.test(await card.locator('h4.ask-heading').innerText()), 'heading text');
});

await check('opening a folded item shows its ask and Open run link', async () => {
  await openItem('Second plain run');
  const it = itemOf('Second plain run');
  ok((await pane().locator('article').count()) === 3, 'opening an item changed the number of items');
  ok((await it.locator('h4.ask-heading').count()) === 1, 'ask not shown');
  ok((await it.locator('a.open-run').getAttribute('href')) === `#/runs/${plain2}`, 'Open run href');
  ok((await it.locator('.ui-dic__body').getAttribute('inert')) === null, 'the opened body is still inert');
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

await check('390 px: no sideways scroll on #/, all three sections reachable', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const h of ['#/', '#/waiting']) {
    await page.goto(`${base}/${h}`);
    await page.locator('main').waitFor();
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth, ms: document.querySelector('main').scrollWidth, mc: document.querySelector('main').clientWidth }));
    ok(m.s <= m.c + 1, `${h} scrolls sideways (${m.s} > ${m.c})`);
    ok(m.ms <= m.mc + 1, `${h} main scrolls sideways (${m.ms} > ${m.mc})`);
  }
  for (const a of await page.locator('nav[aria-label="Sections"] a').all()) {
    const b = await a.boundingBox();
    ok(b && b.x >= 0 && b.x + b.width <= 391, 'a nav link is cut off at 390 px');
  }
  await page.setViewportSize({ width: 1300, height: 900 });
});

await check('live: count drops on the Monitor page without reload after the run is answered elsewhere', async () => {
  await page.goto(`${base}/#/`);
  ok(await until(async () => (await waitingCount()) === '3', 5000), 'start count');
  await page.evaluate(() => { window.__marker = 1; });
  const r = await app.api('POST', `/api/runs/${plain2}/respond`, { body: { action: 'Agree spec', text: '' } });
  ok(r.status === 200, `respond ${r.status} ${r.text}`);
  ok(await until(async () => (await waitingCount()) === '2', 6000), `Views count stayed ${await waitingCount()}`);
  ok(await page.evaluate(() => window.__marker === 1), 'page reloaded instead of updating live');
  ok(await until(async () => (await pane().locator('article').count()) === 2, 3000), 'inbox items did not update');
});

await check('answering from the inbox confirms, folds the item away, opens the next and lowers the count', async () => {
  await page.goto(`${base}/#/`);
  await openItem('Plain gate run');
  const card = itemOf('Plain gate run');
  await card.getByRole('textbox').fill('agreed');
  await card.getByRole('button', { name: /agree spec/i }).click();
  await card.locator('.ui-dic__done[role=status]', { hasText: /agree spec/i }).waitFor({ timeout: 3000 });
  await card.waitFor({ state: 'detached', timeout: 6000 });
  ok(await until(async () => (await waitingCount()) === '1', 5000), `count ${await waitingCount()}`);
  ok((await pane().locator('article').count()) === 1, 'answered run still in the inbox');
  ok((await itemOf('Escalated long ask').locator('h3.ui-dic__title').count()) === 1, 'the next item did not open');
});

await check('empty state after everything is answered', async () => {
  const card = itemOf('Escalated long ask');
  await card.getByRole('button', { name: /stop run/i }).click().catch(() => {});
  ok(await until(async () => (await pane().getByText('Nothing is waiting on you.').count()) === 1, 6000), 'empty text missing');
  ok((await waitingCount()) === '0', 'count not zero');
});

ok(true, '');
results.push(['no uncaught page errors', pageErrors.length ? 'FAIL' : 'PASS', pageErrors.slice(0, 2).join(' | ').slice(0, 200)]);

await browser.close();
await app.srv.close?.();
let failed = 0;
for (const [n, s, m] of results) { if (s !== 'PASS') failed++; console.log(`${s}  ${n}${m ? `  -- ${m}` : ''}`); }
console.log(`${results.length - failed}/${results.length} passed; screenshots in ${SHOTS}`);
process.exit(failed ? 1 : 0);
