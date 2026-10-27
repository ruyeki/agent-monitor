// Holdout UI script (phase B, AC11/AC12 + AC9 in the run view): Stats nav and page, run-view token panel, editor Versions stats.
// WEB_DIR=<temp build dir> node --disable-warning=ExperimentalWarning test/e2e/stats.e2e.mjs
// Selectors are role/text based on purpose: the fact sheet pins routes, labels and copy, not CSS classes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until, hook, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'am-verify-stats-shots-'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const dialogs = [];
const pageErrors = [];
const consoleErrors = [];
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

// ---- fixture transcripts (a temp projects dir; nothing real is read)
const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'am-proj-'));
const tline = ({ id, ts, session, agent, model = 'claude-sonnet-5-5-20261001', input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }) => JSON.stringify({
  type: 'assistant', sessionId: session, ...(agent ? { agentId: agent } : {}), timestamp: new Date(ts).toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 } } },
});
const wr = (file, lines, append = false) => { fs.mkdirSync(path.dirname(file), { recursive: true }); (append ? fs.appendFileSync : fs.writeFileSync)(file, lines.join('\n') + '\n'); };
const dayAgo = (k) => { const d = new Date(); d.setDate(d.getDate() - k); d.setHours(12, 0, 0, 0); return d.getTime(); };
const now = Date.now();
const statsFile = path.join(projects, 'proj', 'sess-stats.jsonl');
// today totals exactly 123456 tokens (100000 + 20000 + 3000 + 456); other days are small, at 1-4 and 40-42 days ago
const rows = [tline({ id: 's-today', ts: now - 2000, session: 'sess-stats', model: 'claude-opus-5-5-20261001', input: 100000, output: 20000, cacheWrite: 3000, cacheRead: 456 })];
for (const k of [1, 2, 3, 4, 40, 41, 42]) rows.push(tline({ id: `s-${k}`, ts: dayAgo(k), session: 'sess-stats', input: 1000 + k, output: 10 }));
wr(statsFile, rows);

const app = await boot({ webDir, projects });
const base = app.url.replace(/\/$/, '');
const get = async (p) => (await app.api('GET', p)).json;
const mcp = await mcpClient(app.url);
const call = async (name, args) => (await mcp.call(name, args)).text;

// a run with a main session and one subagent, then finished (so the version stats have a finished run)
const SESSION = 'sess-run';
const runA = runIdOf(await call('start_run', { title: 'Tokens run' }));
const rp = (s) => path.join(projects, 'proj', `${s}.jsonl`);
await hook(app.port, { hook_event_name: 'PostToolUse', session_id: SESSION, transcript_path: rp(SESSION), cwd: '/x', tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'x' },
  tool_response: { content: [{ type: 'text', text: `RUN ${runA} · stage frame (Frame) · round 0/5 · status active` }] } });
await hook(app.port, { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: rp(SESSION), cwd: '/x', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 't1' });
const rts = Date.now();
wr(rp(SESSION), [tline({ id: 'rm1', ts: rts, session: SESSION, model: 'claude-opus-5-5-20261001', input: 4000, output: 500 })]);
await until(async () => (await get(`/api/runs/${runA}`)).tokens?.main?.total === 4500, 15000, 150);

ok(await until(async () => (await get('/api/stats/usage')).indexer?.messages >= 9, 15000, 150), 'fixture transcripts were not indexed in 15 s');

const step = (stage, outcome = 'done') => call('complete_stage', { run: runA, stage, outcome });
const detailA = async () => get(`/api/runs/${runA}`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1400, height: 1000 }, colorScheme: 'light' });
page = await ctx.newPage();
page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
page.on('pageerror', (e) => pageErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
await page.goto(base + '/');

const navItem = (re) => page.getByRole('link', { name: re }).or(page.getByRole('tab', { name: re })).or(page.getByRole('button', { name: re }));
const bodyText = () => page.locator('body').innerText();
const clickAny = (re) => page.getByRole('button', { name: re }).or(page.getByRole('radio', { name: re })).or(page.getByRole('tab', { name: re })).or(page.getByRole('link', { name: re })).first().click();

await check('header nav shows Monitor, Workflow and Stats, and Stats opens #/stats', async () => {
  for (const n of [/monitor/i, /workflow/i, /stats/i]) ok(await navItem(n).count() > 0, `no nav item ${n}`);
  await navItem(/^\s*stats\s*$/i).first().click();
  await page.waitForURL(/#\/stats/, { timeout: 4000 });
  await page.getByText(/today/i).first().waitFor({ timeout: 8000 });
});

await check('four period cards: Today, This week, This month, Daily average, each with a total, a breakdown and an API-equivalent estimate', async () => {
  const text = await bodyText();
  for (const t of [/today/i, /this week/i, /this month/i, /daily average/i]) ok(t.test(text), `no card ${t}`);
  const tt = (await get('/api/stats/usage')).periods.today.total;
  const forms = [tt.toLocaleString('en-US'), String(tt), tt < 1e6 ? `${(tt / 1000).toFixed(tt < 1e4 ? 1 : 0)}k` : `${(tt / 1e6).toFixed(1)}M`, tt < 1e6 ? `${(tt / 1000).toFixed(1)}k` : `${(tt / 1e6).toFixed(2)}M`];
  ok(tt >= 123456 && forms.some((f) => text.includes(f)), `the Today headline (${tt}) is not on the page as ${forms.join(' | ')}`);
  for (const t of [/input/i, /output/i, /cache write/i, /cache read/i]) ok(t.test(text), `breakdown ${t} missing`);
  ok((text.match(/≈\s*\$/g) || []).length >= 4, 'each card needs an "≈ $" estimate line');
  ok(/API-equivalent/i.test(text) && /estimate/i.test(text), 'estimate is not labelled');
  await page.screenshot({ path: path.join(SHOTS, 'stats-light.png'), fullPage: true });
});

await check('the daily chart is hand-rolled SVG; the 30 / 90 days toggle changes what is drawn', async () => {
  const svg = page.locator('svg').filter({ has: page.locator('rect') });
  ok(await svg.count() > 0, 'no SVG chart with bars');
  await clickAny(/^\s*90\s*(d|days)/i);
  await page.waitForTimeout(400);
  const n90 = await page.locator('svg rect').count();
  await clickAny(/^\s*30\s*(d|days)/i);
  await page.waitForTimeout(400);
  const n30 = await page.locator('svg rect').count();
  ok(n90 > n30, `90 days draws ${n90} rects, 30 days ${n30}`);
  ok(!(await page.evaluate(() => !!window.Chart || !!window.d3 || !!window.Recharts)), 'a chart library is loaded');
});

await check('the split toggle switches the chart between model and token type', async () => {
  await clickAny(/by token type/i);
  await page.waitForTimeout(300);
  ok(/cache write/i.test(await bodyText()), 'token type split shows no token-type legend');
  await clickAny(/by model/i);
  await page.waitForTimeout(300);
  ok(/opus|sonnet/i.test(await bodyText()), 'model split shows no model legend');
});

await check('the indexer status line shows the indexed message and file counts', async () => {
  const text = await bodyText();
  ok(/index/i.test(text), 'no indexer status');
  const st = (await get('/api/stats/usage')).indexer;
  ok(text.includes(String(st.messages)) || text.includes(st.messages.toLocaleString('en-US')), `message count ${st.messages} not on the page`);
});

await check('the per-version table shows finished runs, avg tokens and avg duration, and expands to per-node rows', async () => {
  for (const s of ['frame']) await step(s);
  await app.api('POST', `/api/runs/${runA}/respond`, { body: { action: 'Agree spec', text: 'x' } });
  for (const s of ['plan', 'implement', 'prep']) await step(s);
  for (const s of ['verify', 'review', 'whitehat']) await step(s, 'pass');
  await step('commit'); await step('report');
  await app.api('POST', `/api/runs/${runA}/respond`, { body: { action: 'Accept', text: 'y' } });
  await step('pr');
  ok((await detailA()).run.status === 'done', 'fixture run did not finish');
  await page.reload();
  await page.getByText(/this week/i).first().waitFor({ timeout: 8000 });
  const text = await bodyText();
  ok(/finished/i.test(text) && /avg|average/i.test(text) && /duration/i.test(text), 'version table headings missing');
  const verRow = page.locator('table').filter({ hasText: /finished runs/i }).getByRole('row').filter({ hasText: /v1/ }).first();
  await verRow.waitFor({ timeout: 6000 });
  const before = (await bodyText()).length;
  const toggle = verRow.getByRole('button').first();
  if (await toggle.count()) await toggle.click(); else await verRow.click();
  ok(await until(async () => /Verifier prep/.test(await bodyText()) || (await bodyText()).length > before + 40, 4000), 'the row did not expand to per-node rows');
  ok(/Verifier prep|Implement|Frame/.test(await bodyText()), 'no node names in the expanded rows');
});

await check('the price table is editable, notes its source and saves with PUT /api/prices', async () => {
  const text = await bodyText();
  ok(/claude-api skill, 2026-10-06; estimates only/i.test(text), 'price source note missing');
  const idx = await page.evaluate(() => [...document.querySelectorAll('tr')].findIndex((tr) => /claude-opus-5-5$/.test(tr.innerText.trim().split(/\s+/)[0] || '') || [...tr.querySelectorAll('input')].some((i) => i.value === 'claude-opus-5-5')));
  ok(idx >= 0, 'no claude-opus-5-5 row in the price table');
  const row = page.locator('tr').nth(idx);
  const inputs = row.locator('input');
  const values = await inputs.evaluateAll((els) => els.map((e) => e.value));
  const first = values.findIndex((v) => v !== 'claude-opus-5-5' && v !== '' && !Number.isNaN(Number(v)));
  ok(first >= 0, 'no numeric input in the opus-5-5 row');
  await inputs.nth(first).fill('4.5');
  await page.getByRole('button', { name: /save/i }).first().click();
  ok(await until(async () => (await get('/api/prices')).find((r) => r.model === 'claude-opus-5-5')?.input === 4.5, 5000), 'the edit did not reach /api/prices');
});

await check('Stats refreshes by itself when new usage is indexed (SSE)', async () => {
  const before = await bodyText();
  wr(statsFile, [tline({ id: 's-live', ts: Date.now(), session: 'sess-stats', model: 'claude-opus-5-5-20261001', input: 900000 })], true);
  ok(await until(async () => (await bodyText()) !== before, 14000, 200), 'the page did not change after new transcript data');
  ok(/1\.0\d\s?M|1,0\d\d,\d{3}|1\.02\s?M|1\.0\s?M/.test(await bodyText()) || (await bodyText()) !== before, 'Today did not grow');
});

await check('run view: the side panel shows run tokens with a separate main-session figure and an estimate', async () => {
  await page.goto(`${base}/#/runs/${runA}`);
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 8000 });
  const text = await bodyText();
  ok(/main session/i.test(text), 'no "main session" figure');
  ok(/4,?500|4\.5\s?[kK]/.test(text), 'the main session total 4500 is not shown');
  ok(/≈\s*\$/.test(text) && /estimate/i.test(text), 'no estimate line');
  ok(!/unattributed/i.test(text), 'unattributed is shown although it is 0');
  await page.screenshot({ path: path.join(SHOTS, 'run-tokens.png'), fullPage: true });
});

await check('editor Versions list shows each version stats (finished runs, avg tokens, avg duration)', async () => {
  await page.goto(`${base}/#/workflow`);
  await page.getByText(/Verifier prep/).first().waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: /versions/i }).first().click();
  await page.waitForTimeout(500);
  const text = await bodyText();
  ok(/v1\b/.test(text), 'no v1 in the list');
  ok(/finished/i.test(text) && /avg|average/i.test(text), 'no stats next to the versions');
});

await check('dark theme: Stats renders without page errors', async () => {
  await ctx.close();
  const d = await browser.newContext({ viewport: { width: 1400, height: 1000 }, colorScheme: 'dark' });
  page = await d.newPage();
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  await page.goto(`${base}/#/stats`);
  await page.getByText(/this week/i).first().waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, 'stats-dark.png'), fullPage: true });
});

await check('extra (not an AC) phone width: no horizontal page scroll on Stats', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  await page.waitForTimeout(300);
  const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok(over <= 1, `page scrolls horizontally by ${over}px`);
});

await check('no window dialogs, no uncaught page errors', async () => { ok(dialogs.length === 0, dialogs.join(' ; ')); ok(pageErrors.length === 0, pageErrors.join(' ; ')); });

await browser.close();
try { await mcp.client.close(); } catch { /* ignore */ }
await app.srv.close();
console.log('\nRESULTS');
for (const [n, s, m] of results) console.log(`${s.padEnd(5)} ${n}${m ? '  -> ' + m : ''}`);
console.log(`console errors: ${consoleErrors.length}; screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
