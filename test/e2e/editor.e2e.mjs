// Phase B verify-mode UI script for Agent Monitor: Workflow editor + light AC12 re-check.
// Run:  npm run build && npm run e2e   (needs web/dist built)
// Boots its own server on a free port with a temp home. Never touches ~/.claude. Screenshots go to a temp dir.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'am-e2e-shots-'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const results = [];
const dialogs = [];
let page;
async function check(name, fn) {
  try {
    await fn();
    results.push([name, 'PASS', '']);
  } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 200)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

const webDir = process.env.WEB_DIR || path.join(REPO, 'web', 'dist');
ok(fs.existsSync(path.join(webDir, 'index.html')), 'web/dist is not built');
const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const get = async (p) => (await app.api('GET', p)).json;
const post = (p, body) => app.api('POST', p, { body: body ?? {} });
const order = (wf) => wf.stages.map((s) => s.id);
const draftOrder = async () => order((await get('/api/workflow')).draft.workflow);
const versions = async () => get('/api/workflow/versions');
const savedText = async () => (await page.locator('[role=status]').allInnerTexts()).join(' | ');
const waitSaved = () => until(async () => /saved/i.test(await savedText()) && !/unsaved|saving/i.test(await savedText()), 5000, 100);

// ---- seed runs through MCP (the same path agents use)
const mcp = await mcpClient(app.url);
const inflight = runIdOf((await mcp.call('start_run', { title: 'Inflight before publish' })).text);
const waiting = runIdOf((await mcp.call('start_run', { title: 'Waiting for Ryan' })).text);
await mcp.call('complete_stage', { run: waiting, stage: 'frame', outcome: 'pass' });
const toStop = runIdOf((await mcp.call('start_run', { title: 'Run to stop' })).text);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'light' });
page = await ctx.newPage();
page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(base + '/');

const tab = (name) => page.getByRole('tab', { name });

// ---- AC12 light re-check: Monitor tab
await check('monitor: waiting card responds', async () => {
  const card = page.getByRole('article', { name: /Waiting on you: Waiting for Ryan/ });
  await card.waitFor({ timeout: 5000 });
  ok(/solution/i.test(await card.innerText()), 'card does not show the gate question');
  await card.getByRole('textbox').fill('looks good, agreed');
  await card.getByRole('button', { name: /agree spec/i }).click();
  const r = await until(async () => { const j = await get(`/api/runs/${waiting}`); return j.run.stage === 'plan' ? j : null; }, 5000);
  ok(r, 'run did not move to plan after Agree spec');
  await card.waitFor({ state: 'detached', timeout: 5000 });
});
await check('monitor: Stop confirm flow ends the run', async () => {
  await page.getByRole('row', { name: /Run to stop/ }).first().click();
  await page.getByRole('button', { name: /^stop$/i }).click();
  await page.getByRole('group', { name: /confirm stop/i }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: /^confirm$/i }).click();
  const r = await until(async () => (await get(`/api/runs/${toStop}`)).run.status === 'stopped', 5000);
  ok(r, 'run is not stopped after confirm');
});

// ---- Workflow tab
const openWorkflow = async () => {
  await tab(/workflow/i).click();
  await page.getByRole('button', { name: /^publish$/i }).waitFor({ timeout: 8000 });
};
await check('workflow tab opens with the graph and the stage list', async () => {
  await openWorkflow();
  await page.screenshot({ path: path.join(SHOTS, '01-workflow-light.png') });
  ok(await page.locator('.react-flow').count() > 0, 'no graph rendered');
  ok(await page.getByRole('button', { name: /white-hat/i }).count() > 0, 'White-hat is not listed');
});

const node = (re) => page.locator('.react-flow__node').filter({ hasText: re }).first();
await check('drag White-hat before Review saves the draft in that order', async () => {
  const wh = await node(/white-hat/i).boundingBox();
  const rv = await node(/^\s*review/i).boundingBox();
  ok(wh && rv, 'nodes not found');
  await page.mouse.move(wh.x + wh.width / 2, wh.y + wh.height / 2);
  await page.mouse.down();
  await page.mouse.move(wh.x + wh.width / 2 - 40, wh.y + wh.height / 2 + 4, { steps: 6 });
  await page.mouse.move(rv.x + rv.width / 2, wh.y + wh.height / 2, { steps: 15 });
  await page.mouse.up();
  const o = await until(async () => { const d = await draftOrder(); return d.indexOf('whitehat') < d.indexOf('review') ? d : null; }, 6000);
  ok(o, `draft order after drag: ${(await draftOrder()).join(',')}`);
  ok(await waitSaved(), 'page does not say the draft is saved');
  const txt = await page.locator('body').innerText();
  ok(/saved/i.test(txt), 'no saved text');
  await page.screenshot({ path: path.join(SHOTS, '02-after-drag.png') });
  const pub = (await get('/api/workflow')).published.workflow;
  ok(order(pub).indexOf('whitehat') > order(pub).indexOf('review'), 'published workflow changed before publish');
});
await check('node snaps back to a slot (no stray x position)', async () => {
  await page.waitForTimeout(400);
  const a = await node(/white-hat/i).boundingBox();
  const b = await node(/^\s*review/i).boundingBox();
  ok(a.x < b.x, 'White-hat node is not left of Review after the drop');
});

let draftAfterPublish;
await check('Publish a valid draft creates v2; in-flight run stays on v1', async () => {
  await page.getByRole('button', { name: /^publish$/i }).click();
  const v = await until(async () => (await versions()).length === 2, 6000);
  ok(v, 'v2 was not created');
  const vs = await versions();
  ok(vs.map((x) => x.version).join() === '1,2' || vs.map((x) => x.version).sort().join() === '1,2', 'versions are not 1 and 2');
  const r = (await get(`/api/runs/${inflight}`)).run;
  ok(r.workflowVersion === 1, `in-flight run reports workflowVersion ${r.workflowVersion}`);
  const p = (await get('/api/workflow')).published;
  ok(p.version === 2 && order(p.workflow).indexOf('whitehat') < order(p.workflow).indexOf('review'), 'published v2 does not have the new order');
  ok(/v2/.test(await page.locator('.editor, main').first().innerText()), 'page does not show v2');
  const fresh = runIdOf((await mcp.call('start_run', { title: 'Started after publish' })).text);
  ok((await get(`/api/runs/${fresh}`)).run.workflowVersion === 2, 'new run is not pinned to v2');
  draftAfterPublish = await draftOrder();
});

await check('invalid draft: Publish shows errors and creates no version', async () => {
  await page.getByRole('button', { name: /^1\. /i }).first().click();
  const name = page.getByLabel(/^name$/i).first();
  await name.fill('');
  ok(await waitSaved(), 'invalid draft was not saved');
  const d = (await get('/api/workflow')).draft;
  ok(d.errors.length > 0, 'server does not see the draft as invalid');
  await page.getByRole('button', { name: /^publish$/i }).click();
  await page.waitForTimeout(600);
  const shown = await page.locator('[role=alert], [aria-label="Draft problems"]').allInnerTexts();
  ok(shown.join(' ').trim().length > 0, 'no error text shown');
  ok((await versions()).length === 2, 'a version was created from an invalid draft');
  await page.screenshot({ path: path.join(SHOTS, '03-invalid.png') });
});

await check('Discard draft restores the published order and name (in-page confirm)', async () => {
  await page.getByRole('button', { name: /discard draft/i }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor({ timeout: 3000 });
  await dlg.getByRole('button', { name: /^confirm$/i }).click();
  const r = await until(async () => { const d = (await get('/api/workflow')).draft; return d.errors.length === 0 ? d : null; }, 5000);
  ok(r, 'draft still invalid after discard');
  const pub = (await get('/api/workflow')).published.workflow;
  ok(JSON.stringify(r.workflow) === JSON.stringify(pub), 'draft is not equal to published after discard');
  ok(order(r.workflow).join() === draftAfterPublish.join(), 'order differs from published');
});

await check('load v1 from history into the draft', async () => {
  await page.getByRole('button', { name: /load v1/i }).click();
  const dlg = page.getByRole('alertdialog');
  if (await dlg.count()) await dlg.getByRole('button', { name: /^confirm$/i }).click();
  const o = await until(async () => { const d = await draftOrder(); return d.indexOf('whitehat') > d.indexOf('review') ? d : null; }, 5000);
  ok(o, 'draft does not have the v1 order');
  const v1 = (await get('/api/workflow/versions/1')).workflow;
  ok(order(v1).join() === (await draftOrder()).join(), 'draft differs from v1');
});

await check('Add step adds a stage to the draft; Delete stage removes it', async () => {
  const n0 = (await draftOrder()).length;
  await page.getByRole('button', { name: /add step/i }).click();
  const added = await until(async () => (await draftOrder()).length === n0 + 1, 5000);
  ok(added, 'draft did not gain a stage');
  ok(await waitSaved(), 'not saved after add');
  await page.getByRole('button', { name: /^delete/i }).first().click();
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor({ timeout: 3000 });
  await dlg.getByRole('button', { name: /^confirm$/i }).click();
  const gone = await until(async () => (await draftOrder()).length === n0, 5000);
  ok(gone, 'draft did not lose the stage');
});

await check('keyboard: select a stage and move it with buttons', async () => {
  await get('/api/workflow'); // draft is v1 order: review before whitehat
  const before = await draftOrder();
  const i = before.indexOf('review');
  const item = page.getByRole('button', { name: /review/i }).first();
  await item.focus();
  await page.keyboard.press('Enter');
  const later = page.getByRole('button', { name: /move.*(later|right|down|forward|after|next)/i }).first();
  const earlier = page.getByRole('button', { name: /move.*(earlier|left|up|back|before|previous)/i }).first();
  await later.focus();
  await page.keyboard.press('Enter');
  const o1 = await until(async () => { const d = await draftOrder(); return d.indexOf('review') === i + 1 ? d : null; }, 5000);
  ok(o1, 'Move later did not move the stage by one');
  await earlier.focus();
  await page.keyboard.press('Space');
  const o2 = await until(async () => (await draftOrder()).indexOf('review') === i, 5000);
  ok(o2, 'Move earlier did not move the stage back');
});

await check('no window dialogs fired', async () => ok(dialogs.length === 0, dialogs.join(' ; ')));
await check('no uncaught page errors', async () => ok(pageErrors.length === 0, pageErrors.join(' ; ')));

// ---- dark theme screenshots + crude readability check
await check('dark theme renders with readable text', async () => {
  await ctx.close();
  const dctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, colorScheme: 'dark' });
  page = await dctx.newPage();
  page.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  await page.goto(base + '/');
  await page.screenshot({ path: path.join(SHOTS, '04-monitor-dark.png') });
  await openWorkflow();
  await page.getByRole('button', { name: /^1\. /i }).first().click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(SHOTS, '05-workflow-dark.png') });
  const probe = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const bad = [];
    for (const sel of ['body', '.editor-bar', '.fnode', '.panel', '.panel label', '.stage-list button', 'table td', '.react-flow__edge-text']) {
      const el = document.querySelector(sel);
      if (!el) continue;
      let bgEl = el, bg = 'rgba(0, 0, 0, 0)';
      while (bgEl && /rgba\(0, 0, 0, 0\)|transparent/.test((bg = getComputedStyle(bgEl).backgroundColor))) bgEl = bgEl.parentElement;
      const fg = getComputedStyle(el).color;
      const a = lum(fg), b = lum(bg);
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      if (ratio < 3) bad.push(`${sel} ${fg} on ${bg} = ${ratio.toFixed(1)}`);
    }
    return bad;
  });
  ok(probe.length === 0, 'low contrast: ' + probe.join(' ; '));
});

await browser.close();
await app.srv.close();
console.log('\nRESULTS');
for (const [n, s, m] of results) console.log(`${s.padEnd(5)} ${n}${m ? '  -> ' + m : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
