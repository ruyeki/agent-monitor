// Holdout e2e (Stats page #2246): the cost-first Stats page in a real browser on a built bundle with seeded data.
// Run: WEB_DIR=<built dist> CHROME_PATH=<chromium> [AM_STATS_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-am-stats.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { load, tmp, until, sleep, mcpClient, runIdOf, hook, req, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
const SHOTS = process.env.AM_STATS_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-stats-shots-'));
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
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };

const helpers = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  window.__rgba = rgba;
  const over = (top, bot) => { const a = top[3]; return [top[0] * a + bot[0] * (1 - a), top[1] * a + bot[1] * (1 - a), top[2] * a + bot[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  window.__ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  window.__bgOf = (el) => {
    const chain = [];
    for (let e = el; e; e = e.parentElement) chain.push(e);
    let bg = [255, 255, 255, 1];
    for (const e of chain.reverse()) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg); }
    return bg;
  };
  window.__opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  window.__hue = (c) => { const [r, g2, b] = [c[0] / 255, c[1] / 255, c[2] / 255]; const mx = Math.max(r, g2, b), mn = Math.min(r, g2, b), d = mx - mn; if (!d) return -1; let h = mx === r ? ((g2 - b) / d) % 6 : mx === g2 ? (b - r) / d + 2 : (r - g2) / d + 4; h *= 60; return h < 0 ? h + 360 : h; };
};

async function contrast(p) {
  await p.evaluate(helpers);
  return p.evaluate(() => {
    const bad = []; let n = 0;
    const els = [...document.querySelectorAll('body *')];
    for (const el of els) {
      if (el.closest('.sr-only')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      let text = '';
      const isField = ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName);
      for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
      if (isField) text = (el.value ?? '') + (el.tagName === 'SELECT' ? 'x' : '');
      if (!text.trim()) continue;
      if (el.matches(':disabled') || el.closest('[disabled]')) continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const svgText = el instanceof SVGElement;
      const bg = window.__bgOf(el);
      let fg = window.__rgba(svgText ? cs.fill : cs.color);
      fg[3] *= window.__opacity(el);
      const eff = fg[3] < 1 ? [fg[0] * fg[3] + bg[0] * (1 - fg[3]), fg[1] * fg[3] + bg[1] * (1 - fg[3]), fg[2] * fg[3] + bg[2] * (1 - fg[3]), 1] : fg;
      const size = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10);
      const large = size >= 24 || (size >= 18.66 && w >= 700);
      const ratio = window.__ratio(eff, bg); n++;
      if (ratio < (large ? 3 : 4.5) && el.closest('.react-flow__attribution')) { window.__attr = ratio.toFixed(2); continue; }
      if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName.toLowerCase()}.${(el.getAttribute('class') || '').toString().split(' ')[0]} "${text.trim().slice(0, 24)}" ${ratio.toFixed(2)}`);
    }
    return { n, bad };
  });
}

// ---------- seed: 7 models over 45 days (10 days in the previous 30-day period), cache reads dominate tokens
const projects = tmp('am-stats-proj-');
const tline = ({ id, ts, session, model, input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }) => JSON.stringify({
  type: 'assistant', sessionId: session, timestamp: new Date(ts).toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 } } },
});
const dayAt = (k, h = 12) => { const d = new Date(); d.setDate(d.getDate() - k); d.setHours(h, 0, 0, 0); return d.getTime(); };
const MODELS = ['claude-opus-5-5-20261001', 'claude-opus-5', 'claude-sonnet-5-5-20261001', 'claude-sonnet-4-6', 'claude-haiku-4-5-20251001', 'claude-haiku-5-5', 'claude-fable-5'];
const lines = [];
let n = 0;
for (const k of [0, 1, 2, 3, 4, 6, 9, 12, 15, 18, 22, 26, 29, 33, 36, 40, 44, 59]) {
  MODELS.forEach((m, i) => {
    if ((k + i) % 3 === 2 && k !== 0) return;
    lines.push(tline({ id: `m${++n}`, ts: dayAt(k, 8 + i), session: 'sess-stats', model: m, input: 20000 * (i + 1), output: 4000 + 500 * i, cacheWrite: 3000 * (7 - i), cacheRead: i === 5 ? 3e8 : 4e6 * (i + 1) }));
  });
}
fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
const statsFile = path.join(projects, 'proj', 'sess-stats.jsonl');
fs.writeFileSync(statsFile, lines.join('\n') + '\n');
const SESSION = 'sess-run';
const runFile = path.join(projects, 'proj', `${SESSION}.jsonl`);

const { startServer } = await load('src/server.js');
const srv = await startServer({ port: 0, dataDir: tmp('am-stats-home-'), projectsDir: projects, webDir });
const base = srv.url.replace(/\/$/, '');
const get = async (p) => (await req(srv.port, 'GET', p)).json;
const mcp = await mcpClient(srv.url);
const call = async (name, args) => (await mcp.call(name, args)).text;
const done = (run, stage, outcome = 'done') => call('complete_stage', { run, stage, outcome });

const RA = runIdOf(await call('start_run', { title: 'Finished run' }));
await hook(srv.port, { hook_event_name: 'PostToolUse', session_id: SESSION, transcript_path: runFile, cwd: '/x', tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'x' }, tool_response: { content: [{ type: 'text', text: `RUN ${RA} · stage frame (Frame) · round 0/5 · status active` }] } });
await hook(srv.port, { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: runFile, cwd: '/x', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 't1' });
fs.writeFileSync(runFile, tline({ id: 'rm1', ts: Date.now(), session: SESSION, model: 'claude-opus-5-5-20261001', input: 40000, output: 5000 }) + '\n');
await until(async () => (await get(`/api/runs/${RA}`)).tokens?.main?.total === 45000, 15000, 150);
await done(RA, 'frame'); await sleep(40);
await req(srv.port, 'POST', `/api/runs/${RA}/respond`, { body: { action: 'Agree spec', text: 'x' } });
for (const s of ['plan', 'implement', 'prep']) { await done(RA, s); await sleep(40); }
for (const s of ['verify', 'review', 'whitehat']) { await done(RA, s, 'pass'); await sleep(40); }
await done(RA, 'commit'); await done(RA, 'report');
await req(srv.port, 'POST', `/api/runs/${RA}/respond`, { body: { action: 'Accept', text: 'y' } });
await done(RA, 'pr');
const RE = runIdOf(await call('start_run', { title: 'Stopped run' })); await done(RE, 'frame'); await req(srv.port, 'POST', `/api/runs/${RE}/stop`, { body: {} });
const RB = runIdOf(await call('start_run', { title: 'Open run' }));
ok((await get(`/api/runs/${RA}`)).run.status === 'done', 'fixture run did not finish');
ok(await until(async () => (await get('/api/stats/usage')).indexer?.messages >= lines.length, 20000, 150), 'transcripts were not indexed');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
async function newPage({ theme = 'dark', width = 1300, height = 900, init } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* */ } }, theme);
  if (init) await ctx.addInitScript(init);
  ctx.setDefaultTimeout(4000);
  const p = await ctx.newPage();
  p.on('request', (r) => requests.push(r.url()));
  p.on('pageerror', (e) => pageErrors.push(String(e)));
  return { ctx, p };
}
const openStats = async (p) => { try { await p.goto(`${base}/#/stats`); await p.locator('section[aria-label="Usage summary"]').waitFor({ timeout: 8000 }); await p.locator('rect[data-hit]').first().waitFor({ timeout: 4000 }); await p.waitForTimeout(300); } catch (e) { notes.push('openStats: ' + String(e.message).split(String.fromCharCode(10))[0]); } };
const pressed = (group, name) => page.getByRole('group', { name: group }).getByRole('button', { name }).getAttribute('aria-pressed');
const legend = () => page.locator('ul.legend[aria-label="Legend"] li').allInnerTexts().then((a) => a.map((t) => t.trim()));
const fillOf = (label) => page.evaluate((l) => { const r = document.querySelector(`.daily-chart path.series-line[data-series="${l}"]`); return r ? getComputedStyle(r).stroke : null; }, label);
const bodyText = () => page.locator('body').innerText();

let { ctx, p } = await newPage({ theme: 'dark' });
page = p;
const usageReqs = [];
page.on('request', (r) => { if (r.url().includes('/api/stats/usage')) usageReqs.push([Date.now(), r.url()]); });
const T0 = Date.now();
await openStats(page);

await check('header: Stats h1, Range and Metric groups, defaults 30 days + Cost, API-equivalent caption', async () => {
  ok(await page.getByRole('heading', { level: 1, name: 'Stats' }).count() === 1, 'no h1 Stats');
  for (const [g, names] of [['Range', ['7 days', '30 days', '90 days']], ['Metric', ['Cost', 'Tokens']]]) for (const nm of names) ok(await page.getByRole('group', { name: g }).getByRole('button', { name: nm }).count() === 1, `${g}/${nm}`);
  ok(await pressed('Range', '30 days') === 'true' && await pressed('Metric', 'Cost') === 'true', 'defaults are not 30 days + Cost');
  ok(/API-equivalent/i.test(await bodyText()) && /estimate/i.test(await bodyText()), 'no estimate caption');
  ok(usageReqs.some(([, u]) => u.includes('days=60')), `first usage fetch is not days=60: ${usageReqs.map((x) => x[1]).join(' ')}`);
});

await check('KPI strip: four tiles with cost headlines and token sub-lines; no 4-row breakdown; switch swaps them', async () => {
  const tiles = page.locator('section[aria-label="Usage summary"] .stat');
  ok(await tiles.count() === 4, `${await tiles.count()} tiles`);
  const labels = await tiles.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label')));
  ok(JSON.stringify(labels) === JSON.stringify(['Today', 'This week', 'This month', 'Daily average (30 d)']), labels.join('|'));
  const u = await get('/api/stats/usage');
  const val = await tiles.nth(0).locator('.stat-value').innerText();
  ok(/^\$[\d,]+\.\d\d$|^<\$0\.01$/.test(val), `Today headline is not a cost: ${val}`);
  ok(/tokens$/.test(await tiles.nth(0).locator('.stat-sub').innerText()), 'sub-line is not tokens');
  const txt = (await tiles.allInnerTexts()).join(' ');
  ok(!/cache (write|read)|\binput\b|\boutput\b/i.test(txt), 'tiles still list a token breakdown');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Tokens' }).click();
  const v2 = await tiles.nth(0).locator('.stat-value').innerText();
  ok(!/^\$/.test(v2) && /^[\d.]+[kMB]?$/.test(v2.trim()), `Today headline in Tokens mode: ${v2}`);
  ok(/^≈ \$/.test(await tiles.nth(0).locator('.stat-sub').innerText()), 'sub-line is not the cost');
  ok(u.periods.today.total > 0, 'no today data seeded');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Cost' }).click();
});

await check('chart: <= 5 models + Other, short labels, ranked by metric, colours stable across metric/split switches', async () => {
  const lg = await legend();
  ok(lg.length === 6 && lg[5] === 'Other', `legend ${lg.join(' | ')}`);
  ok(lg.every((l) => !/claude-|\d{8}/.test(l)), `long labels in legend: ${lg.join(' | ')}`);
  ok(lg.some((l) => /^(Opus|Sonnet|Haiku|Fable) \d/.test(l)), `no short family labels: ${lg.join(' | ')}`);
  const before = Object.fromEntries(await Promise.all(lg.filter((l) => l !== 'Other').map(async (l) => [l, await fillOf(l)])));
  ok(Object.values(before).every(Boolean), 'a legend series has no line');
  ok(new Set(Object.values(before)).size === 5, 'series colours repeat');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Tokens' }).click();
  const lg2 = await legend();
  ok(lg2.length === 6 && lg2.at(-1) === 'Other', `tokens legend ${lg2.join(' | ')}`);
  ok(lg2.slice(0, 5).join() !== lg.slice(0, 5).join(), 'cost and token rankings are identical although cache reads dominate tokens');
  for (const l of lg2.filter((x) => x !== 'Other')) if (before[l]) ok(await fillOf(l) === before[l], `${l} was repainted by the metric switch`);
  await page.getByRole('button', { name: 'By token type' }).click();
  ok(JSON.stringify(await legend()) === JSON.stringify(['Input', 'Output', 'Cache write', 'Cache read']), 'type split legend');
  await page.getByRole('button', { name: 'By model' }).click();
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Cost' }).click();
  for (const l of Object.keys(before)) ok(await fillOf(l) === before[l], `${l} repainted after a round trip`);
});

await check('chart: 4-5 gridlines with labels, delta and range total in the head, 30 hit areas, svg label and sr-only table', async () => {
  const g = await page.locator('section.daily-chart svg line.grid').count();
  ok(g >= 4 && g <= 5, `${g} gridlines`);
  ok(await page.locator('rect[data-hit]').count() === 30, `${await page.locator('rect[data-hit]').count()} hit rects`);
  const delta = await page.locator('.delta[aria-label="Change vs previous period"]').innerText();
  ok(/^(▲|▼) \d+% vs previous 30 days$|^No change vs previous 30 days$/.test(delta.trim()), `delta: ${delta}`);
  ok(/^\$/.test((await page.locator('.range-total').innerText()).trim()) || /\$/.test(await page.locator('.range-total').innerText()), 'range total is not a cost');
  ok(/^Lines of daily cost over the last 30 days, .+ in total\. The table below has the numbers\.$/.test(await page.locator('section.daily-chart svg[role="img"]').getAttribute('aria-label')), 'svg aria-label');
  ok(await page.getByRole('table', { name: 'Daily cost table' }).count() === 1, 'no sr-only table');
  ok(await page.getByRole('heading', { level: 2, name: 'Daily cost' }).count() === 1, 'no Daily cost heading');
});

await check('keyboard: Tab reaches the chart, arrows move through days, tooltip lists series with % share, Escape hides', async () => {
  await page.locator('rect[data-hit]').first().evaluate((e) => e.ownerSVGElement.scrollIntoView({ block: 'center' }));
  let hit = false;
  await page.locator('h1').first().focus().catch(() => {});
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  for (let i = 0; i < 80 && !hit; i++) { await page.keyboard.press('Tab'); hit = await page.evaluate(() => document.activeElement?.hasAttribute('data-hit')); }
  ok(hit, 'the chart cannot be reached with Tab');
  ok(await page.locator('rect[data-hit][tabindex="0"]').count() === 1, 'not a single tab stop');
  const d0 = await page.evaluate(() => document.activeElement.getAttribute('data-hit'));
  await page.keyboard.press('ArrowLeft');
  const d1 = await page.evaluate(() => document.activeElement.getAttribute('data-hit'));
  ok(d1 < d0, `ArrowLeft did not move to an earlier day (${d0} -> ${d1})`);
  await page.keyboard.press('End');
  const dEnd = await page.evaluate(() => document.activeElement.getAttribute('data-hit'));
  const days = await page.locator('rect[data-hit]').evaluateAll((e) => e.map((x) => x.getAttribute('data-hit')));
  ok(dEnd === days.at(-1), `End did not reach the last day (${dEnd})`);
  const tip = page.locator('.tooltip[role="status"]');
  ok(await tip.count() === 1, 'no tooltip on keyboard focus');
  const tt = await tip.innerText();
  ok(/\$/.test(tt) && /\(\d+(\.\d)?%\)/.test(tt), `tooltip text: ${tt}`);
  ok(/^[A-Z][a-z]{2} \d{1,2} · /.test(tt.trim()), `tooltip head: ${tt.split('\n')[0]}`);
  await page.keyboard.press('Home');
  ok(await page.evaluate(() => document.activeElement.getAttribute('data-hit')) === days[0], 'Home');
  await page.keyboard.press('Escape');
  ok(await page.locator('.tooltip').count() === 0, 'Escape did not hide the tooltip');
  await page.locator('rect[data-hit]').nth(days.length - 1).hover({ force: true });
  ok(await page.locator('.tooltip').count() === 1, 'hover shows no tooltip');
});

await check('Spend by model: top 5 models + Other ranked by cost as a donut legend with value, share and the other metric; follows the metric switch', async () => {
  const sec = page.getByRole('region', { name: 'Spend by model' });
  ok(await sec.getByRole('heading', { level: 2, name: 'Spend by model' }).count() === 1, 'no heading');
  const items = sec.locator('ol[aria-label="Models ranked by cost"] li[data-model]');
  ok(await items.count() === 6, `${await items.count()} models`); // 7 models: 5 + Other
  const txt = await items.allInnerTexts();
  ok(txt.every((t) => /\$/.test(t) && /\d+(\.\d)?%/.test(t)), 'a row misses cost or share');
  const costs = txt.map((t) => Number(/\$([\d,]+\.\d\d)/.exec(t)?.[1].replace(/,/g, '') ?? NaN));
  ok(costs.slice(0, 5).every((c, i) => i === 0 || costs[i - 1] >= c), `not sorted by cost: ${costs.join(' ')}`); // Other is last and may be bigger than the fifth
  const shares = txt.map((t) => Number(/(\d+(?:\.\d)?)%/.exec(t)[1]));
  ok(Math.abs(shares.reduce((a, b) => a + b, 0) - 100) <= 4, `shares add up to ${shares.reduce((a, b) => a + b, 0)}`);
  ok(await items.evaluateAll((els) => els.every((e) => /^[A-Z]/.test(e.getAttribute('data-model')))), 'data-model is not the short label');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Tokens' }).click();
  ok(await sec.locator('ol[aria-label="Models ranked by tokens"] li[data-model]').count() === 6, 'tokens list');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Cost' }).click();
});

await check("Where a run's tokens go: per-stage donut for the version with finished runs, in workflow order, skipping empty stages; compact version table", async () => {
  const sec = page.getByRole('region', { name: "Where a run's tokens go" });
  await sec.waitFor({ timeout: 8000 });
  const stages = (await sec.locator('li[data-stage]').evaluateAll((e) => e.map((x) => x.getAttribute('data-stage')))).filter((x) => x !== 'not-staged' && x !== 'other-stages'); // the synthetic rows come after the stages
  ok(stages.length >= 1 && stages[0] === 'frame', `stages: ${stages.join(',')}`);
  const wf = (await get('/api/stats/versions'))[0].nodes.map((x) => x.id);
  ok(stages.every((s, i) => i === 0 || wf.indexOf(stages[i - 1]) < wf.indexOf(s)), `not in workflow order: ${stages.join(',')}`);
  ok(!stages.includes('done') && !stages.includes('parallel'), `skipped stages shown: ${stages.join(',')}`);
  ok(/1 finished run/.test(await sec.innerText()) && /per run/.test(await sec.innerText()), 'summary line');
  ok(await sec.getByRole('table', { name: 'Workflow versions' }).count() === 1, 'no versions table');
  ok(await page.getByRole('button', { name: /Show nodes of/ }).count() === 0, 'expand buttons still there');
  ok(await sec.getByRole('group', { name: 'Version' }).count() === 0, 'version selector with a single version');
});

await check('Runs panel: per-day line chart, outcome counts, median duration, average fix rounds', async () => {
  const sec = page.getByRole('region', { name: 'Runs' });
  ok(await sec.getByRole('heading', { level: 2, name: 'Runs' }).count() === 1, 'no heading');
  const aria = await sec.locator('svg[role="img"]').getAttribute('aria-label');
  ok(/^Runs started per day over the last 30 days, 3 in total$/.test(aria), aria);
  ok(await sec.locator('path.series-line[data-series="runs"]').count() === 1, 'no runs line');
  ok(await sec.locator('rect[data-run-hit]').evaluateAll((e) => e.filter((x) => !/ · 0 runs$/.test(x.getAttribute('aria-label'))).length) === 1, 'days with runs'); // all three runs started today
  ok(await sec.getByRole('table', { name: 'Runs per day table' }).count() === 1, 'no sr-only table');
  const o = async (k) => (await sec.locator(`[data-outcome="${k}"]`).innerText());
  ok(/finished/i.test(await o('finished')) && /1/.test(await o('finished')), `finished: ${await o('finished')}`);
  ok(/stopped/i.test(await o('stopped')) && /1/.test(await o('stopped')), `stopped: ${await o('stopped')}`);
  ok(/open/i.test(await o('open')) && /1/.test(await o('open')), `open: ${await o('open')}`);
  const t = await sec.innerText();
  ok(/Median duration/.test(t) && /Avg fix rounds/.test(t), 'labels missing');
  ok(/Avg fix rounds\s*\n?\s*0\.0/.test(t), `avg fix rounds is not 0.0: ${t.replace(/\n/g, ' | ')}`);
  ok(!/Median duration\s*\n?\s*[-–]\s/.test(t), 'median duration is a dash although a run finished');
});

await check('Prices: a closed details at the bottom; opening it shows the table inside its own scroller', async () => {
  const d = page.locator('details.prices');
  ok(await d.count() === 1, 'no details.prices');
  ok(!(await d.evaluate((e) => e.open)), 'prices are open by default');
  ok((await d.locator('summary').innerText()).trim() === 'Prices ($ per million tokens)', 'summary text');
  ok(await d.evaluate((e) => e.getBoundingClientRect().top > document.querySelector('section[aria-label="Runs"]').getBoundingClientRect().top), 'prices are not below Runs');
  await d.locator('summary').click();
  ok(await d.locator('.table-scroll table input[type=number]').count() > 20, 'inputs missing after opening');
  const nowrap = await d.locator('tbody td').first().evaluate((e) => getComputedStyle(e).whiteSpace);
  ok(/nowrap/.test(nowrap), `model id cell white-space: ${nowrap}`);
  const label = await d.locator('input').first().getAttribute('aria-label');
  ok(/^claude-.+ (Input|Output)/.test(label), label);
  await d.locator('summary').click();
});

await check('remembered choices: 7 days + Tokens survive a reload; the 7-day range fetches days=14 at once', async () => {
  const before = usageReqs.length;
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '7 days' }).click();
  ok(await until(async () => usageReqs.slice(before).some(([, u]) => u.includes('days=14')), 1500, 50), 'no immediate fetch for days=14');
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Tokens' }).click();
  await page.reload();
  await page.locator('rect[data-hit]').first().waitFor({ timeout: 8000 });
  ok(await pressed('Range', '7 days') === 'true' && await pressed('Metric', 'Tokens') === 'true', 'choices were not remembered');
  ok(await page.locator('rect[data-hit]').count() === 7, 'range 7 does not draw 7 days');
  ok(/vs previous 7 days|previous 7 days/.test(await page.locator('.delta').innerText()), 'delta label for 7 days');
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '90 days' }).click();
  await page.waitForTimeout(500);
  ok(usageReqs.some(([, u]) => u.includes('days=180')), 'no days=180 fetch');
  await page.getByRole('group', { name: 'Range' }).getByRole('button', { name: '30 days' }).click();
  await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Cost' }).click();
  await page.waitForTimeout(300);
});

await check('storage that throws does not break the page', async () => {
  const t = await newPage({ theme: 'dark', init: () => { const boom = () => { throw new Error('storage blocked'); }; try { Object.defineProperty(window, 'localStorage', { get: boom }); } catch { /* */ } } });
  const prev = page; page = t.p;
  try {
    await openStats(page);
    ok(await pressed('Range', '30 days') === 'true' && await pressed('Metric', 'Cost') === 'true', 'defaults');
    await page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: 'Tokens' }).click();
    ok(await pressed('Metric', 'Tokens') === 'true', 'switch does not work without storage');
    ok(await page.locator('section.daily-chart h2').innerText() === 'Daily tokens', 'chart did not follow');
  } finally { await t.ctx.close(); page = prev; }
});

// ---------- live refresh throttle (keeps the dark page open; mount fetch happened at T0)
await check('throttle: live transcript events cause at most one extra usage refetch per 30 s, and the page still catches up', async () => {
  const mountReqs = usageReqs.filter(([t]) => t >= T0).length; // include everything since load, incl. the range tests above are excluded below
  const windowStart = Date.now();
  const startCount = usageReqs.length;
  const beforeToday = await page.locator('section[aria-label="Usage summary"] .stat').first().locator('.stat-value').innerText();
  for (let i = 0; i < 6; i++) {
    fs.appendFileSync(statsFile, tline({ id: `live-${i}`, ts: Date.now(), session: 'sess-stats', model: 'claude-opus-5-5-20261001', input: 2_000_000 }) + '\n');
    await sleep(3000);
  }
  const inWindow = usageReqs.slice(startCount).filter(([t]) => t - windowStart <= 22000).length;
  ok(inWindow <= 1, `${inWindow} usage fetches in ~22 s of live events (limit 1 per 30 s)`);
  const changed = await until(async () => (await page.locator('section[aria-label="Usage summary"] .stat').first().locator('.stat-value').innerText()) !== beforeToday, 45000, 500);
  ok(changed, `Today did not update within 45 s (still ${beforeToday}); mount fetches seen: ${mountReqs}`);
  const total = usageReqs.slice(startCount).length;
  ok(total <= 3, `${total} usage fetches over the whole live window`);
});

await ctx.close();

// ---------- both themes, two widths: contrast, no sideways scroll, screenshots
for (const theme of ['dark', 'light']) {
  const t = await newPage({ theme, width: 1300, height: 900 });
  page = t.p;
  await openStats(page);
  await check(`[${theme}] contrast >= 4.5:1 for all Stats text (tooltip shown, prices opened)`, async () => {
    await page.locator('rect[data-hit]').nth(5).hover({ force: true });
    await page.waitForTimeout(200);
    let r = await contrast(page);
    ok(r.n > 40, `only ${r.n} text nodes checked`);
    ok(r.bad.length === 0, r.bad.slice(0, 6).join(' ; '));
    await page.getByRole('button', { name: 'Tokens' }).click();
    await page.locator('details.prices summary').click();
    r = await contrast(page);
    ok(r.bad.length === 0, 'Tokens/prices open: ' + r.bad.slice(0, 6).join(' ; '));
    await page.locator('details.prices summary').click();
    await page.getByRole('button', { name: 'Cost' }).click();
  });
  await check(`[${theme}] series are distinguishable and visible against the panel`, async () => {
    await page.evaluate(helpers);
    const info = await page.evaluate(() => { const out = []; for (const li of document.querySelectorAll('ul.legend li')) { const lab = li.textContent.trim(); const r = document.querySelector(`.daily-chart path.series-line[data-series="${lab}"]`); if (!r) continue; out.push([lab, getComputedStyle(r).stroke, window.__ratio(window.__rgba(getComputedStyle(r).stroke), window.__bgOf(r))]); } return out; });
    ok(info.length >= 5, `${info.length} series found`);
    ok(new Set(info.map((x) => x[1])).size === info.length, 'two series share a colour');
    const weak = info.filter((x) => x[0] !== 'Other' && x[2] < 3);
    if (weak.length) notes.push(`${theme}: series below 3:1 against the background (advisory, not an AC): ${weak.map((x) => `${x[0]} ${x[2].toFixed(2)}`).join(', ')}`);
    const other = info.find((x) => x[0] === 'Other'); if (other && other[2] < 3) notes.push(`${theme}: Other ${other[2].toFixed(2)}:1 vs background`);
  });
  await check(`[${theme}] 1300 px: no sideways page scroll; screenshot`, async () => {
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `page scrolls sideways by ${over}px`);
    await page.screenshot({ path: path.join(SHOTS, `stats-${theme}-1300.png`), fullPage: true });
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(600);
  await check(`[${theme}] 390 px: no sideways page scroll, prices closed then open; screenshot`, async () => {
    const over = () => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(await over() <= 1, `closed: scrolls sideways by ${await over()}px`);
    ok(!(await page.locator('details.prices').evaluate((e) => e.open)), 'prices open at 390');
    await page.screenshot({ path: path.join(SHOTS, `stats-${theme}-390.png`), fullPage: true });
    await page.locator('details.prices summary').click();
    await page.waitForTimeout(200);
    ok(await over() <= 1, `prices open: scrolls sideways by ${await over()}px`);
    const sc = await page.locator('details.prices .table-scroll').evaluate((e) => ({ sw: e.scrollWidth, cw: e.clientWidth, ox: getComputedStyle(e).overflowX }));
    ok(sc.sw > sc.cw && /auto|scroll/.test(sc.ox), `the table does not scroll inside its own wrapper (${JSON.stringify(sc)})`);
    await page.locator('details.prices summary').click();
    const tiles = await page.locator('section[aria-label="Usage summary"] .stat').evaluateAll((els) => els.map((e) => e.getBoundingClientRect().width));
    ok(tiles.every((w) => w > 120), `a KPI tile is squeezed: ${tiles.join(',')}`);
    const chartW = await page.locator('section.daily-chart svg').first().evaluate((e) => e.getBoundingClientRect().width);
    ok(chartW > 250 && chartW <= 390, `chart width ${chartW}`);
  });
  await t.ctx.close();
}

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
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
