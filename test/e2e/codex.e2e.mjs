// Holdout UI script: Codex hand-off shown in the run view, graph, runs table and stats. Temp server only.
// WEB_DIR=<temp build dir> node test/e2e/codex.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { until, started, completed, REPO, makeRepo, STUB, mcpClient, runIdOf, req } from '../holdout-codex-helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cx-shots-'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a temp build'); process.exit(2); }
if (path.resolve(webDir) === path.resolve(REPO, 'web', 'dist')) { console.error('refusing web/dist'); process.exit(2); }

const results = []; const pageErrors = []; let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 220)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_')}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const { startServer } = await import(new URL(`file:///${REPO}/src/server.js`).href);
// Boot with the real build.
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amx-stub-'));
fs.writeFileSync(path.join(stubDir, 'script.json'), JSON.stringify({ default: { events: [started('TUI'), completed()] } }));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'amx-root-')));
makeRepo(root, 'repoA');
const srv = await startServer({ port: 0, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'amx-home-')), projectsDir: fs.mkdtempSync(path.join(os.tmpdir(), 'amx-proj-')), webDir, usageIntervalMs: 500, codex: { command: process.execPath, args: [STUB, stubDir], root } });
const mcp = await mcpClient(srv.url);
const call = async (n, x) => (await mcp.call(n, x)).text;
const claudeRun = runIdOf(await call('start_run', { title: 'Plain Claude run', repo: 'repoA' }));
const codexRun = runIdOf(await call('start_run', { title: 'Handed over run', repo: 'repoA' }));
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'PostToolUse', session_id: 'ui1', cwd: root, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: codexRun }, tool_response: {}, tool_use_id: 'x' } });
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'StopFailure', session_id: 'ui1', cwd: root, error: 'rate_limit', error_details: { resetsAt: Math.floor(Date.now() / 1000) + 7200 } } });
await until(async () => { const d = (await req(srv.port, 'GET', `/api/runs/${codexRun}`)).json; return d.run.provider === 'codex' && d.tokens?.codex?.total > 0; }, 8000);
await call('complete_stage', { run: codexRun, stage: 'frame', outcome: 'done' });

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'light' });
page = await ctx.newPage();
page.on('pageerror', (e) => pageErrors.push(String(e)));
const base = srv.url;
const text = async () => (await page.locator('body').innerText());

await check('run view of a handed-over run shows Codex, the limit time and Codex tokens', async () => {
  await page.goto(`${base}/#/runs/${codexRun}`);
  await page.getByText('Handed over run').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(800);
  const t = await text();
  ok(/Codex/.test(t), 'no Codex badge');
  ok(/Claude usage ran out/i.test(t), 'no "Claude usage ran out" line');
  ok(/resets/i.test(t), 'no reset time');
  ok(/Codex tokens/i.test(t), 'no "Codex tokens" figure');
  await page.screenshot({ path: path.join(SHOTS, 'run-codex.png') });
});
await check('graph marks Codex nodes', async () => {
  const n = await page.getByText('Codex', { exact: true }).count();
  ok(n >= 2, `expected a badge and a node marker, found ${n}`);
});
await check('a Claude-only run shows no Codex text', async () => {
  await page.goto(`${base}/#/runs/${claudeRun}`);
  await page.getByText('Plain Claude run').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(500);
  const t = await text();
  ok(!/Claude usage ran out/i.test(t) && !/Codex tokens/i.test(t), 'Codex text leaked into a Claude run');
});
await check('waiting card tags the Codex run; the monitor row of a Claude run is not tagged', async () => {
  await page.goto(`${base}/#/`);
  const card = page.getByRole('article', { name: /Waiting on you: Handed over run/ });
  await card.waitFor({ timeout: 8000 });
  ok(/Codex/.test(await card.innerText()), 'card has no Codex tag');
  await page.goto(`${base}/#/`);
  await page.getByText('Plain Claude run').first().waitFor({ timeout: 8000 });
  const plain = page.locator('tr, li, [role=row]', { hasText: 'Plain Claude run' }).first();
  ok(!/Codex/.test(await plain.innerText()), 'Claude row tagged Codex');
});
await check('stats shows a separate Codex line', async () => {
  await page.goto(`${base}/#/stats`);
  await page.waitForTimeout(1500);
  ok(/Codex/.test(await text()), 'no Codex line on the stats page');
});
await check('no page errors', async () => { ok(pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200)); });

await browser.close(); await mcp.client.close(); await srv.close();
for (const [n, s, m] of results) console.log(`${s}  ${n}${m ? '  -- ' + m : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
