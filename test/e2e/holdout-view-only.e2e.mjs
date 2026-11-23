// Holdout e2e (am-view-only): each sidebar view shows only its own content, on the built bundle.
// Run: WEB_DIR=<copy of the build> CHROME_PATH=<chrome> [HV_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-view-only.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = process.env.HV_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-view-only-shots-'));
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

const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const mcp = await mcpClient(app.url);
const start = async (t) => runIdOf((await mcp.call('start_run', { title: t })).text);
for (const n of ['Alpha', 'Beta', 'Gamma']) {
  const id = await start(`${n} gate run`);
  await mcp.call('complete_stage', { run: id, stage: 'frame', outcome: 'pass' });
  await new Promise((r) => setTimeout(r, 80));
}
for (const n of ['Delta', 'Epsilon']) await start(`${n} busy run`);
for (const n of ['Zeta', 'Eta', 'Theta']) { const id = await start(`${n} finished run`); await app.api('POST', `/api/runs/${id}/stop`, { body: {} }); }
const runs = await app.api('GET', '/api/runs').then((r) => r.json);
ok(runs.filter((r) => r.status === 'waiting').length === 3, 'seed: 3 waiting');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function open(scheme = 'light', layout = null, w = 1440) {
  const ctx = await browser.newContext({ viewport: { width: w, height: 900 }, colorScheme: scheme });
  await ctx.addInitScript(([t, l]) => { try { localStorage.setItem('agent-monitor-theme', t); if (l) localStorage.setItem('agent-monitor-layout', l); } catch { /* ignore */ } }, [scheme, layout]);
  const p = await ctx.newPage();
  await p.goto(`${base}/#/`);
  await p.locator('main').waitFor();
  return { ctx, p };
}
const goView = async (p, name) => { await p.locator('nav[aria-label="Views"]').getByRole('button', { name: new RegExp(`^${name}`) }).click(); await p.waitForTimeout(500); };
const h1 = (p) => p.locator('h1').allInnerTexts();
const inbox = (p) => p.locator('aside.inbox-pane[aria-label="Decision inbox"]');
const kpi = (p) => p.locator('section.stat-strip[aria-label="Today"]');
const body = (p) => p.locator('main').innerText();

await check('Needs you: only the 3 question cards; no KPI strip, no run list, h1 Needs you', async () => {
  const { ctx, p } = await open(); page = p;
  await until(async () => (await inbox(p).locator('article').count()) === 3, 6000);
  await goView(p, 'Needs you');
  ok(JSON.stringify(await h1(p)) === '["Needs you"]', `h1 ${await h1(p)}`);
  ok((await inbox(p).locator('article').count()) === 3, 'cards');
  ok((await kpi(p).count()) === 0, 'KPI strip shown');
  ok((await p.locator('section.run-list').count()) === 0, 'run list shown');
  const t = await body(p);
  ok(!/Delta busy|Zeta finished/.test(t), 'other runs shown');
  await p.screenshot({ path: path.join(SHOTS, 'needs-you-1440-light.png'), fullPage: true });
  await ctx.close();
});

await check('Running: only the 2 running runs; no KPI strip, no inbox, no Finished; h1 Running', async () => {
  const { ctx, p } = await open(); page = p;
  await goView(p, 'Running');
  ok(JSON.stringify(await h1(p)) === '["Running"]', `h1 ${await h1(p)}`);
  ok((await kpi(p).count()) === 0, 'KPI strip shown');
  ok((await inbox(p).count()) === 0, 'inbox shown');
  const t = await body(p);
  ok(/Delta busy/.test(t) && /Epsilon busy/.test(t), 'running runs missing');
  ok(!/Alpha gate|Zeta finished/.test(t), 'waiting or finished runs shown');
  ok((await p.locator('h2.group-head', { hasText: 'Finished' }).count()) === 0, 'Finished group shown');
  await p.screenshot({ path: path.join(SHOTS, 'running-1440-light.png'), fullPage: true });
  await ctx.close();
  const d = await open('dark'); page = d.p;
  await goView(d.p, 'Running');
  await d.p.screenshot({ path: path.join(SHOTS, 'running-1440-dark.png'), fullPage: true });
  await d.ctx.close();
});

await check('Finished: only the 3 finished runs, open; no KPI strip, no inbox; h1 Finished; no layout toggle', async () => {
  const { ctx, p } = await open('light', 'fleet'); page = p;
  await goView(p, 'Finished');
  ok(JSON.stringify(await h1(p)) === '["Finished"]', `h1 ${await h1(p)}`);
  ok((await kpi(p).count()) === 0, 'KPI strip shown');
  ok((await inbox(p).count()) === 0, 'inbox shown');
  ok((await p.getByRole('group', { name: 'Layout' }).count()) === 0, 'layout toggle shown');
  const t = await body(p);
  ok(/Zeta finished/.test(t) && /Eta finished/.test(t) && /Theta finished/.test(t), 'finished runs missing');
  ok(!/Delta busy|Alpha gate/.test(t), 'other runs shown');
  ok(await p.evaluate(() => localStorage.getItem('agent-monitor-layout')) === 'fleet', 'saved layout changed');
  await p.screenshot({ path: path.join(SHOTS, 'finished-1440-light.png'), fullPage: true });
  await ctx.close();
});

await browser.close();
await app.srv.close?.();
let bad = 0;
for (const [n, s, m] of results) { if (s !== 'PASS') bad++; console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`); }
console.log(`\n${results.length - bad}/${results.length} passed; shots in ${SHOTS}`);
process.exit(bad ? 1 : 0);
