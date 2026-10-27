// Holdout UI script (AC7, AC8, AC14): full-page graph editor and the run view, through the built app.
// WEB_DIR=<temp build dir> node --disable-warning=ExperimentalWarning test/e2e/graph.e2e.mjs
// Selectors are role/text based on purpose: the fact sheet pins routes and button names, not CSS classes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'am-verify-shots-'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const dialogs = [];
const pageErrors = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 220)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };

const webDir = process.env.WEB_DIR || path.join(REPO, 'web', 'dist');
ok(fs.existsSync(path.join(webDir, 'index.html')), 'no built app at ' + webDir);
const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const get = async (p) => (await app.api('GET', p)).json;
const put = (p, body) => app.api('PUT', p, { body });
const draft = async () => (await get('/api/workflow')).draft;
const mcp = await mcpClient(app.url);
const call = async (name, args) => (await mcp.call(name, args)).text;

const parallel = runIdOf(await call('start_run', { title: 'Parallel run' }));
await call('complete_stage', { run: parallel, stage: 'frame', outcome: 'done' });
await app.api('POST', `/api/runs/${parallel}/respond`, { body: { action: 'Agree spec', text: 'x' } });
await call('complete_stage', { run: parallel, stage: 'plan', outcome: 'done' });
const waiting = runIdOf(await call('start_run', { title: 'Waiting for Ryan' }));
await call('complete_stage', { run: waiting, stage: 'frame', outcome: 'done' });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'light' });
page = await ctx.newPage();
page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(base + '/');

await check('header nav has Monitor, Workflow and Stats', async () => {
  for (const n of [/monitor/i, /workflow/i, /stats/i]) {
    const hit = page.getByRole('link', { name: n }).or(page.getByRole('tab', { name: n })).or(page.getByRole('button', { name: n }));
    ok(await hit.count() > 0, `no nav item ${n}`);
  }
});

await check('Monitor: the waiting card still responds (v1 behaviour)', async () => {
  const card = page.getByRole('article', { name: /Waiting on you: Waiting for Ryan/ });
  await card.waitFor({ timeout: 6000 });
  await card.getByRole('textbox').fill('agreed');
  await card.getByRole('button', { name: /agree spec/i }).click();
  ok(await until(async () => (await get(`/api/runs/${waiting}`)).run.stage === 'plan', 5000), 'run did not reach plan');
});

await check('clicking a run row opens #/runs/<id> with the pinned graph', async () => {
  await page.getByRole('row', { name: /Parallel run/ }).first().click();
  await page.waitForURL(new RegExp(`#/runs/${parallel}`), { timeout: 4000 });
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 6000 });
  ok(await page.getByText(/implement/i).count() > 0, 'Implement node is not shown');
  ok(await page.getByText(/gate 2|accept, push|Gate2/i).count() > 0 || await page.getByText(/decision/i).count() > 0, 'the rest of the graph is not drawn');
  await page.screenshot({ path: path.join(SHOTS, 'run-parallel.png') });
});

await check('run view: both active nodes are visible together, and the page reports a duration', async () => {
  const text = await page.locator('body').innerText();
  ok(/implement/i.test(text) && /verifier prep|prep/i.test(text), 'both parallel nodes are not on the page');
  ok(/\d+\s*(s|sec|m|min|h|ms)\b/i.test(text) || /duration/i.test(text), 'no duration shown');
});

await check('run view updates live when a branch completes (SSE)', async () => {
  const before = await page.locator('body').innerText();
  await call('complete_stage', { run: parallel, stage: 'implement', outcome: 'done' });
  const changed = await until(async () => (await page.locator('body').innerText()) !== before, 5000);
  ok(changed, 'page did not change after complete_stage');
  await call('complete_stage', { run: parallel, stage: 'prep', outcome: 'done' });
  ok(await until(async () => (await get(`/api/runs/${parallel}`)).run.stage === 'verify', 4000), 'run did not join to verify');
});

await check('run view of a waiting run shows the ask and its action buttons; answering works', async () => {
  const w = runIdOf(await call('start_run', { title: 'Gate in run view' }));
  await call('complete_stage', { run: w, stage: 'frame', outcome: 'done' });
  await page.goto(`${base}/#/runs/${w}`);
  await page.getByText(/What's your solution/).first().waitFor({ timeout: 6000 });
  await page.getByRole('button', { name: /agree spec/i }).first().click();
  ok(await until(async () => (await get(`/api/runs/${w}`)).run.stage === 'plan', 5000), 'respond from the run view did not move the run');
});

await check('Stop from the run view ends the run', async () => {
  const s = runIdOf(await call('start_run', { title: 'Stop me' }));
  await page.goto(`${base}/#/runs/${s}`);
  await page.getByRole('button', { name: /^stop$/i }).first().click();
  const confirm = page.getByRole('button', { name: /^confirm$/i });
  if (await confirm.count()) await confirm.first().click();
  ok(await until(async () => (await get(`/api/runs/${s}`)).run.status === 'stopped', 5000), 'run is not stopped');
});

await check('#/workflow is a full-page editor with the seed graph, the palette and the top bar', async () => {
  await page.goto(`${base}/#/workflow`);
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 8000 });
  for (const n of ['Step', 'Check', 'Gate', 'Split', 'Join', 'End']) ok(await page.getByText(new RegExp(`^\\s*${n}\\s*$`)).count() > 0, `palette item ${n} missing`);
  const text = await page.locator('body').innerText();
  ok(/Published v\d+/i.test(text), 'no "Published vN"');
  ok(/draft/i.test(text) && /saved/i.test(text), 'no draft saved indicator');
  for (const n of [/^publish$/i, /discard/i, /versions/i, /layout/i]) ok(await page.getByRole('button', { name: n }).count() > 0, `button ${n} missing`);
  await page.screenshot({ path: path.join(SHOTS, 'editor-light.png') });
});

await check('dragging Step from the palette onto the canvas adds a node to the saved draft', async () => {
  const n0 = (await draft()).workflow.nodes.length;
  const src = page.getByText(/^\s*Step\s*$/).first();
  const canvas = page.locator('.react-flow__pane, .react-flow, [data-testid="rf__wrapper"]').first();
  await src.dragTo(canvas, { targetPosition: { x: 300, y: 500 } });
  ok(await until(async () => (await draft()).workflow.nodes.length === n0 + 1, 6000), 'draft did not gain a node');
  const added = (await draft()).workflow.nodes.at(-1);
  ok(added.type === 'step' && Number.isFinite(added.position?.x) && Number.isFinite(added.position?.y), 'the new node has no saved position');
});

await check('selecting a node opens the settings panel with its fields', async () => {
  await page.getByText(/Verifier prep/).first().click();
  const name = page.getByLabel(/^name$/i).first();
  await name.waitFor({ timeout: 4000 });
  ok((await name.inputValue()).includes('Verifier prep'), 'panel does not show the selected node');
  for (const l of [/runner/i, /model/i, /instructions/i]) ok(await page.getByLabel(l).count() > 0, `field ${l} missing`);
  await name.fill('Verifier prep 2');
  ok(await until(async () => (await draft()).workflow.nodes.some((n) => n.name === 'Verifier prep 2'), 6000), 'rename did not reach the draft');
  await name.fill('Verifier prep');
});

await check('auto-layout button saves distinct positions on the 220 grid', async () => {
  await page.getByRole('button', { name: /layout/i }).first().click();
  const ok1 = await until(async () => {
    const ns = (await draft()).workflow.nodes;
    const keys = new Set(ns.map((n) => `${n.position.x},${n.position.y}`));
    return keys.size === ns.length && ns.every((n) => n.position.x % 220 === 0) ? ns : null;
  }, 6000);
  ok(ok1, 'positions are not laid out');
});

await check('an invalid draft: Publish lists the problem, creates no version, highlights something', async () => {
  const w = JSON.parse(JSON.stringify((await draft()).workflow));
  w.edges = w.edges.filter((e) => !(e.from === 'verify' && e.on === 'fail'));
  await put('/api/workflow/draft', { workflow: w });
  await page.reload();
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 8000 });
  const nv = (await get('/api/workflow/versions')).length;
  await page.getByRole('button', { name: /^publish$/i }).click();
  await page.waitForTimeout(700);
  const alerts = (await page.locator('[role=alert], [aria-label*="problem" i], [aria-label*="error" i]').allInnerTexts()).join(' ');
  ok(/verify/i.test(alerts), `the error list does not name the offending node: "${alerts.slice(0, 120)}"`);
  ok((await get('/api/workflow/versions')).length === nv, 'a version was created from an invalid draft');
  await page.screenshot({ path: path.join(SHOTS, 'editor-invalid.png') });
});

await check('Discard restores the published graph', async () => {
  await page.getByRole('button', { name: /discard/i }).first().click();
  const dlg = page.getByRole('alertdialog');
  if (await dlg.count()) await dlg.getByRole('button', { name: /^confirm$/i }).click();
  ok(await until(async () => (await draft()).errors.length === 0, 5000), 'draft is still invalid');
});

await check('Publish a valid draft creates the next version; the Versions list shows it', async () => {
  const w = JSON.parse(JSON.stringify((await draft()).workflow));
  w.nodes.find((n) => n.id === 'frame').name = 'Frame it';
  await put('/api/workflow/draft', { workflow: w });
  await page.reload();
  await page.getByText(/Frame it/).first().waitFor({ timeout: 8000 });
  const before = (await get('/api/workflow/versions')).length;
  await page.getByRole('button', { name: /^publish$/i }).click();
  ok(await until(async () => (await get('/api/workflow/versions')).length === before + 1, 6000), 'no new version');
  await page.getByRole('button', { name: /versions/i }).first().click();
  ok(await page.getByText(/v1\b/).count() > 0, 'Versions list does not show v1');
});

await check('dark theme: editor and run view render readable text', async () => {
  await ctx.close();
  const d = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark' });
  page = await d.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/#/workflow`);
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, 'editor-dark.png') });
  const bad = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const out = [];
    for (const el of document.querySelectorAll('button, label, h1, h2, h3, [role=status]')) {
      if (!el.textContent.trim()) continue;
      let b = el, bg;
      while (b && /rgba\(0, 0, 0, 0\)|transparent/.test(bg = getComputedStyle(b).backgroundColor)) b = b.parentElement;
      if (!b) continue;
      const a = lum(getComputedStyle(el).color), c = lum(bg);
      const ratio = (Math.max(a, c) + 0.05) / (Math.min(a, c) + 0.05);
      if (ratio < 3) out.push(`${el.tagName} "${el.textContent.trim().slice(0, 20)}" ${ratio.toFixed(1)}`);
    }
    return out.slice(0, 5);
  });
  ok(bad.length === 0, 'low contrast: ' + bad.join(' ; '));
});

await check('no window dialogs and no uncaught page errors', async () => { ok(dialogs.length === 0, dialogs.join(' ; ')); ok(pageErrors.length === 0, pageErrors.join(' ; ')); });

await browser.close();
await app.srv.close();
console.log('\nRESULTS');
for (const [n, s, m] of results) console.log(`${s.padEnd(5)} ${n}${m ? '  -> ' + m : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
