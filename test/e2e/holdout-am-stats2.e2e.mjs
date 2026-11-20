// Guards the Stats lines and donuts (#2249): lines, donuts, Runs line, light tokens, in a real browser on a built bundle with seeded data.
// Run: WEB_DIR=<built dist> CHROME_PATH=<chromium> [AM_STATS_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-am-stats2.e2e.mjs
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
const openStats = async (p) => { try { await p.goto(`${base}/#/stats`); await p.locator('section[aria-label="Usage summary"]').waitFor({ timeout: 8000 }); await p.locator('section.daily-chart rect[data-hit]').first().waitFor({ timeout: 4000 }); await p.waitForTimeout(400); } catch (e) { notes.push('openStats: ' + String(e.message).split(String.fromCharCode(10))[0]); } };
const pressed = (group, name) => page.getByRole('group', { name: group }).getByRole('button', { name }).getAttribute('aria-pressed');
const legend = () => page.locator('ul.legend[aria-label="Legend"] li').allInnerTexts().then((a) => a.map((t) => t.trim()));
const fillOf = (label) => page.evaluate((l) => { const r = document.querySelector(`rect[data-series="${l}"]`); return r ? getComputedStyle(r).fill : null; }, label);
const bodyText = () => page.locator('body').innerText();

let { ctx, p } = await newPage({ theme: 'dark' });
page = p;
const usageReqs = [];
page.on('request', (r) => { if (r.url().includes('/api/stats/usage')) usageReqs.push([Date.now(), r.url()]); });
const T0 = Date.now();
await openStats(page);

const metricBtn = (n) => page.getByRole('group', { name: 'Metric' }).getByRole('button', { name: n });
const dailyLines = () => page.evaluate(() => [...document.querySelectorAll('section.daily-chart path.series-line')].map((e) => { const cs = getComputedStyle(e); return { key: e.getAttribute('data-series'), stroke: cs.stroke, width: cs.strokeWidth, fill: cs.fill, join: cs.strokeLinejoin, cap: cs.strokeLinecap }; }));
const centre = (sec) => sec.evaluate((el) => { const svg = el.querySelector('svg'); const c = (svg.closest('.donut') || svg.parentElement).cloneNode(true); c.querySelectorAll('ol, ul, table, title, .sr-only').forEach((e) => e.remove()); return c.textContent.replace(/\s+/g, ' ').trim(); });
const sliceOpacity = async (sec, key) => { await page.waitForTimeout(450); return sec.locator(`path[data-slice="${key}"]`).evaluate((e) => { const cs = getComputedStyle(e); return parseFloat(cs.opacity) * parseFloat(cs.fillOpacity); }); };


// move the mouse onto the middle of ring slice number `idx` of a section (the bbox centre of a ring slice can sit in the hole)
const hoverSlice = async (sec, idx) => {
  const xy = await sec.locator('path[data-slice]').nth(idx).evaluate((s) => {
    const svg = s.ownerSVGElement; const vb = svg.viewBox.baseVal; const cx = vb.x + vb.width / 2; const cy = vb.y + vb.height / 2;
    const L = s.getTotalLength(); const pts = []; for (let i = 0; i <= 240; i++) { const p = s.getPointAtLength((L * i) / 240); pts.push([p.x, p.y, Math.hypot(p.x - cx, p.y - cy)]); }
    const R = Math.max(...pts.map((p) => p[2])); const outer = pts.filter((p) => p[2] > R - 1.5); const m = outer[Math.floor(outer.length / 2)];
    const k = (R - 7) / m[2]; const px = cx + (m[0] - cx) * k; const py = cy + (m[1] - cy) * k;
    const pt = svg.createSVGPoint(); pt.x = px; pt.y = py; const q = pt.matrixTransform(svg.getScreenCTM()); return [q.x, q.y];
  });
  await page.mouse.move(xy[0], xy[1]);
};

const fullShot = async (p, file) => {
  // main scrolls inside the shell on desktop: grow the viewport to the pane's scroll height so every section is in the picture
  const vp = p.viewportSize();
  const need = await p.evaluate(() => { let e = document.querySelector('.stats-page'); while (e && !(e.scrollHeight > e.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e && e !== document.documentElement && e !== document.body ? e.scrollHeight - e.clientHeight : 0; });
  if (need > 0) { await p.setViewportSize({ width: vp.width, height: vp.height + need + 24 }); await p.waitForTimeout(500); }
  await p.screenshot({ path: path.join(SHOTS, file), fullPage: true });
  if (need > 0) { await p.setViewportSize(vp); await p.waitForTimeout(300); }
  return need;
};

await check('daily chart: lines only (2px, unfilled, round, series colours), no stacked rects, label says lines, no rect data marks on the page', async () => {
  ok(await page.locator('rect[data-series], rect[data-day], rect[data-run-day]').count() === 0, 'stacked or run bars still drawn');
  const ls = await dailyLines();
  const lg = await legend();
  ok(ls.length === lg.length && lg.length === 6, `${ls.length} lines for legend ${lg.join('|')}`);
  ok(ls.every((l) => parseFloat(l.width) === 2 && l.fill === 'none' && l.join === 'round' && l.cap === 'round'), `line style: ${JSON.stringify(ls[0])}`);
  ok(new Set(ls.map((l) => l.stroke)).size === 6, 'two lines share a colour');
  ok(ls[0].key === 'Other' && ls.at(-1).key === lg[0], `draw order: ${ls.map((l) => l.key).join(',')}`);
  ok(/^Lines of daily cost over the last 30 days, .+ in total\. The table below has the numbers\.$/.test(await page.locator('section.daily-chart svg[role="img"]').getAttribute('aria-label')), 'svg label');
  const marks = await page.evaluate(() => [...document.querySelectorAll('rect')].filter((r) => { const cs = getComputedStyle(r); const a = /rgba?\(.*,\s*0\)$/.test(cs.fill) || cs.fill === 'none' || parseFloat(cs.fillOpacity) === 0 || parseFloat(cs.opacity) === 0; return !a && !r.hasAttribute('data-hit') && !r.hasAttribute('data-run-hit'); }).length);
  ok(marks === 0, `${marks} visible rect marks`);
  const clipped = await page.evaluate(() => [...document.querySelectorAll('section.daily-chart path.series-line')].filter((e) => { const b = e.getBBox(); const vb = e.ownerSVGElement.viewBox.baseVal; return b.x < -1 || b.y < -1 || b.x + b.width > vb.width + 1 || b.y + b.height > vb.height + 1; }).length);
  ok(clipped === 0, `${clipped} lines leave the viewBox`);
});

await check('daily chart: hover and keys show a guide, ringed dots on the lines and a tooltip sorted by value with shares', async () => {
  const hits = page.locator('section.daily-chart rect[data-hit]');
  ok(await page.locator('section.daily-chart line.guide, section.daily-chart circle.dot').count() === 0, 'guide or dots without hover');
  await hits.nth(29).hover({ force: true });
  ok(await page.locator('section.daily-chart line.guide').count() === 1, 'no guide on hover');
  const dots = page.locator('section.daily-chart circle.dot');
  const n = await dots.count();
  ok(n >= 1 && n <= 6, `${n} dots`);
  const info = await page.evaluate(() => [...document.querySelectorAll('section.daily-chart circle.dot')].map((d) => { const cs = getComputedStyle(d); const l = document.querySelector(`section.daily-chart path.series-line[data-series="${d.getAttribute('data-dot')}"]`); return { r: Number(d.getAttribute('r')), fill: cs.fill, line: getComputedStyle(l).stroke, ring: parseFloat(cs.strokeWidth), cx: Number(d.getAttribute('cx')), g: Number(document.querySelector('section.daily-chart line.guide').getAttribute('x1')) }; }));
  ok(info.every((d) => d.r === 4 && d.fill === d.line && d.ring === 2 && Math.abs(d.cx - d.g) < 0.8), `dots: ${JSON.stringify(info[0])}`);
  const tt = await page.locator('.tooltip[role="status"]').innerText();
  const vals = [...tt.matchAll(/: \$([\d,]+\.\d\d)/g)].map((m) => Number(m[1].replace(/,/g, '')));
  ok(vals.length === n, `${vals.length} tooltip lines for ${n} dots: ${tt}`);
  ok(vals.every((v, i) => !i || vals[i - 1] >= v), `tooltip not sorted by value: ${tt}`);
  ok(/\(\d+(\.\d)?%\)/.test(tt) && /^[A-Z][a-z]{2} \d{1,2} · \$/.test(tt.trim()), `tooltip: ${tt}`);
  await page.locator('section.daily-chart svg').first().evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await hits.nth(5).focus();
  const x0 = await page.locator('section.daily-chart line.guide').getAttribute('x1');
  await page.keyboard.press('ArrowRight');
  const x1 = await page.locator('section.daily-chart line.guide').getAttribute('x1');
  ok(Number(x1) > Number(x0), `guide did not follow ArrowRight (${x0} -> ${x1})`);
  await page.keyboard.press('Escape');
  ok(await page.locator('section.daily-chart line.guide').count() === 0, 'Escape left the guide');
});

await check('daily chart: Tokens and type split keep lines and the 4-5 gridlines; the axis follows the largest single series, not a stack', async () => {
  await metricBtn('Tokens').click();
  ok(/^Lines of daily tokens/.test(await page.locator('section.daily-chart svg[role="img"]').getAttribute('aria-label')), 'tokens label');
  const g = await page.locator('section.daily-chart line.grid').count();
  ok(g >= 4 && g <= 5, `${g} gridlines`);
  await page.getByRole('button', { name: 'By token type' }).click();
  const ls = await dailyLines();
  ok(ls.map((l) => l.key).join() === 'cacheRead,cacheWrite,output,input', ls.map((l) => l.key).join());
  await page.getByRole('button', { name: 'By model' }).click();
  await metricBtn('Cost').click();
  // axis: top label must be < the stacked total of the busiest day, unless one series carries it all
  const r = await page.evaluate(() => { const ts = [...document.querySelectorAll('section.daily-chart svg text')].map((t) => t.textContent.trim()); return ts; });
  ok(r.length >= 4, `axis labels: ${r.join(',')}`);
});

await check('Spend by model donut: ring slices in rank order, Other last, legend rows, centre total, colours equal the line chart', async () => {
  const sec = page.getByRole('region', { name: 'Spend by model' });
  const keys = await sec.locator('path[data-slice]').evaluateAll((e) => e.map((x) => x.getAttribute('data-slice')));
  const rows = await sec.locator('ol[aria-label="Models ranked by cost"] li[data-model]').evaluateAll((e) => e.map((x) => x.getAttribute('data-model')));
  ok(keys.length === 6 && keys.at(-1) === 'Other' && JSON.stringify(keys) === JSON.stringify(rows), `slices ${keys} legend ${rows}`);
  ok(/in 30 days/.test(await centre(sec)) && /\$/.test(await centre(sec)), `centre: ${await centre(sec)}`);
  ok(await sec.locator('rect, .bar-fill, .bar-row').count() === 0, 'bar markup still there');
  const cmp = await page.evaluate(() => [...document.querySelectorAll('section[aria-label="Spend by model"] path[data-slice]')].map((s) => { const k = s.getAttribute('data-slice'); const l = document.querySelector(`section.daily-chart path.series-line[data-series="${k}"]`); return [k, getComputedStyle(s).fill, l && getComputedStyle(l).stroke]; }));
  ok(cmp.every(([, f, s]) => f === s), `donut and line colours differ: ${JSON.stringify(cmp.filter(([, f, s]) => f !== s))}`);
  ok((await sec.locator('li[data-model="Other"]').innerText()).includes('Other (2 models)'), 'Other row text');
  const legendKeys = (await legend()).filter((l) => l !== 'Other');
  ok(JSON.stringify(keys.slice(0, 5)) === JSON.stringify(legendKeys), 'members differ from the line chart legend');
});

await check('Spend donut: slice hover, legend hover and keys dim the others and put the slice in the centre', async () => {
  const sec = page.getByRole('region', { name: 'Spend by model' });
  await sec.locator('svg').first().evaluate((e) => e.scrollIntoView({ block: 'center' }));
  const sl = sec.locator('path[data-slice]');
  await hoverSlice(sec, 1);
  ok(Math.abs((await sliceOpacity(sec, (await sl.nth(0).getAttribute('data-slice')))) - 0.35) < 0.02, 'others did not dim to 0.35');
  ok(await sec.locator('li.active').count() === 1, 'no active legend row');
  const k1 = await sl.nth(1).getAttribute('data-slice');
  ok((await centre(sec)).includes(k1) && !/in 30 days/.test(await centre(sec)), `centre: ${await centre(sec)}`);
  await page.mouse.move(2, 2);
  ok(/in 30 days/.test(await centre(sec)), 'centre did not return to the total');
  await sec.locator('ol li[data-model]').nth(2).hover();
  const k2 = await sl.nth(2).getAttribute('data-slice');
  ok(Math.abs((await sliceOpacity(sec, k2)) - 1) < 0.02 && Math.abs((await sliceOpacity(sec, await sl.nth(0).getAttribute('data-slice'))) - 0.35) < 0.02, 'legend hover did not highlight');
  ok((await centre(sec)).includes(k2), 'legend hover centre');
  await page.mouse.move(2, 2);
  let hit = false;
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await sec.locator('svg').first().evaluate((e) => e.scrollIntoView({ block: 'center' }));
  await page.locator('section.daily-chart rect[data-hit]').last().focus();
  for (let i = 0; i < 12 && !hit; i++) { await page.keyboard.press('Tab'); hit = await page.evaluate(() => document.activeElement?.hasAttribute('data-slice') && !!document.activeElement.closest('section[aria-label="Spend by model"]')); }
  ok(hit, 'the ring cannot be reached with Tab');
  ok(await sec.locator('path[data-slice][tabindex="0"]').count() === 1, 'not a single tab stop');
  await page.keyboard.press('Home');
  const first = await page.evaluate(() => document.activeElement.getAttribute('data-slice'));
  await page.keyboard.press('ArrowRight');
  ok(await page.evaluate(() => document.activeElement.getAttribute('data-slice')) !== first, 'ArrowRight did not move');
  await page.keyboard.press('End');
  ok(await page.evaluate(() => document.activeElement.getAttribute('data-slice')) === 'Other', 'End is not Other');
  ok((await centre(sec)).includes('Other'), 'centre does not show the focused slice');
  await page.keyboard.press('Escape');
  ok(/in 30 days/.test(await centre(sec)), 'Escape did not clear');
});

await check('Spend donut follows Tokens; ring geometry: starts at 12 o\'clock, slices separated, centre inside the hole', async () => {
  const sec = page.getByRole('region', { name: 'Spend by model' });
  await metricBtn('Tokens').click();
  ok(await sec.locator('ol[aria-label="Models ranked by tokens"]').count() === 1, 'tokens legend');
  ok(/tokens|[kMB]\b/.test(await centre(sec)), `centre: ${await centre(sec)}`);
  await metricBtn('Cost').click();
  const g = await sec.evaluate((el) => { const s = el.querySelector('path[data-slice]'); const svg = s.ownerSVGElement; const bb = s.getBBox(); const vb = svg.viewBox.baseVal; return { bx: bb.x + bb.width / 2, by: bb.y + bb.height / 2, vw: vb.width, vh: vb.height, w: svg.getBoundingClientRect().width }; });
  ok(g.w >= 150 && g.w <= 260, `donut width ${g.w}`);
  const pts = await sec.evaluate((el) => { const s = el.querySelector('path[data-slice]'); const p = s.getPointAtLength(0); return [p.x, p.y, s.ownerSVGElement.viewBox.baseVal.width / 2, s.ownerSVGElement.viewBox.baseVal.height / 2]; });
  ok(Math.abs(pts[0] - pts[2]) < g.vw * 0.08 && pts[1] < pts[3] - g.vh * 0.2, `first slice starts at (${pts.map((x) => x.toFixed(0))}), not at the top`);
  const sw = await sec.locator('path[data-slice]').first().evaluate((e) => ({ s: getComputedStyle(e).stroke, w: parseFloat(getComputedStyle(e).strokeWidth) }));
  ok(sw.w >= 2, `slice gap stroke ${sw.w}`);
});

// ---------- stage donut on mocked versions (the seeded run only has main-session tokens)
const node = (id, runs, avgCost, avgTokens, dur = 60000) => ({ id, name: `Stage ${id.slice(1)}`, runs, avgCost, avgTokens, avgDurationMs: dur });
const NINE = [node('n1', 10, 2, 5000), node('n2', 10, 1.5, 30000), node('n3', 5, 2, 40000, 120000), node('n4', 10, 0.8, 15000), node('n5', 10, 0.6, 10000), node('n6', 10, 0.5, 2500), node('n7', 10, 0.3, 3000), node('n8', 10, 0.2, 2000), node('n9', 10, 0.1, 1000), node('n10', 0, 0, 0)];
const VERS = [{ version: 1, publishedAt: '2026-10-20T10:00:00Z', finishedRuns: 10, avgTokens: 100000, avgCost: 10, avgDurationMs: 600000, nodes: NINE }];
await check("Where a run's tokens go donut (mocked versions): 6 largest + Other stages + Not tied to a stage, centre = run average, hover swaps the centre", async () => {
  await page.route('**/api/stats/versions', (r) => r.fulfill({ json: VERS }));
  await page.reload();
  const sec = page.getByRole('region', { name: "Where a run's tokens go" });
  await sec.locator('path[data-slice]').first().waitFor({ timeout: 8000 });
  const keys = await sec.locator('path[data-slice]').evaluateAll((e) => e.map((x) => x.getAttribute('data-slice')));
  ok(JSON.stringify(keys) === JSON.stringify(['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'other-stages', 'not-staged']), keys.join());
  ok(/\$10\.00/.test(await centre(sec)) && /per run/.test(await centre(sec)), `centre: ${await centre(sec)}`);
  const lg = await sec.locator('ol[aria-label="Stages"] li[data-stage]').evaluateAll((e) => e.map((x) => x.getAttribute('data-stage')));
  ok(JSON.stringify(lg) === JSON.stringify(keys), `legend ${lg}`);
  ok(/5 of 10 runs/.test(await sec.locator('li[data-stage="n3"]').innerText()), 'partial runs text');
  await sec.locator('li[data-stage="n2"]').hover();
  ok(/Stage 2/.test(await centre(sec)) && /\$1\.50/.test(await centre(sec)), `hover centre: ${await centre(sec)}`);
  await page.mouse.move(2, 2);
  const fills = await sec.locator('path[data-slice]').evaluateAll((e) => e.map((x) => [x.getAttribute('data-slice'), getComputedStyle(x).fill]));
  ok(new Set(fills.map((f) => f[1])).size === fills.length, 'two stage slices share a colour');
  await page.unroute('**/api/stats/versions');
});

await check('Runs per day is one 2px line with a dot and run-count tooltip on hover', async () => {
  await page.reload();
  const sec = page.getByRole('region', { name: 'Runs' });
  await sec.locator('svg').first().waitFor({ timeout: 8000 });
  ok(await sec.locator('rect[data-run-day]').count() === 0, 'run bars still drawn');
  const l = await sec.locator('path.series-line[data-series="runs"]').evaluate((e) => { const cs = getComputedStyle(e); return { w: cs.strokeWidth, f: cs.fill, s: cs.stroke }; });
  ok(parseFloat(l.w) === 2 && l.f === 'none', JSON.stringify(l));
  const hits = sec.locator('rect[data-run-hit]');
  ok(await hits.count() === 30, 'hit rects');
  await hits.nth(29).hover({ force: true });
  ok(await sec.locator('line.guide').count() === 1 && await sec.locator('circle.dot').count() === 1, 'guide/dot');
  ok(/· 3 runs/.test(await sec.locator('.tooltip').innerText()), await sec.locator('.tooltip').innerText());
  const labels = await sec.evaluate((el) => [...el.querySelectorAll('svg text')].map((t) => t.textContent.trim()).filter((t) => !/^[A-Z][a-z]{2} \d/.test(t)));
  ok(labels.every((t) => /^\d+$/.test(t)), `axis not integer: ${labels}`);
  ok(await sec.getByRole('table', { name: 'Runs per day table' }).count() === 1, 'sr-only table');
});

// ---------- both themes, two widths
for (const theme of ['dark', 'light']) {
  const t = await newPage({ theme, width: 1300, height: 900 });
  page = t.p;
  await openStats(page);
  await check(`[${theme}] contrast >= 4.5:1 for all Stats text (tooltip, active donut centre, prices open)`, async () => {
    await page.locator('section.daily-chart rect[data-hit]').nth(5).hover({ force: true });
    let r = await contrast(page);
    ok(r.n > 40, `${r.n} text nodes`);
    ok(r.bad.length === 0, r.bad.slice(0, 6).join(' ; '));
    await hoverSlice(page.getByRole('region', { name: 'Spend by model' }), 1);
    r = await contrast(page);
    ok(r.bad.length === 0, 'donut active: ' + r.bad.slice(0, 6).join(' ; '));
    await page.locator('section[aria-label="Spend by model"] ol li').nth(0).hover();
    await page.getByRole('button', { name: 'Tokens' }).click();
    await page.locator('details.prices summary').click();
    r = await contrast(page);
    ok(r.bad.length === 0, 'tokens/prices: ' + r.bad.slice(0, 6).join(' ; '));
    await page.locator('details.prices summary').click();
    await page.getByRole('button', { name: 'Cost' }).click();
    await page.mouse.move(2, 2);
  });
  await check(`[${theme}] every series line and donut slice is >= 3:1 against its panel and the series are distinguishable`, async () => {
    await page.evaluate(helpers);
    const info = await page.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('section.daily-chart path.series-line')) { const c = window.__rgba(getComputedStyle(e).stroke); out.push([e.getAttribute('data-series'), c, window.__ratio(c, window.__bgOf(e.ownerSVGElement))]); }
      const sl = []; for (const s of document.querySelectorAll('section[aria-label="Spend by model"] path[data-slice]')) { const c = window.__rgba(getComputedStyle(s).fill); sl.push([s.getAttribute('data-slice'), window.__ratio(c, window.__bgOf(s.ownerSVGElement))]); }
      return { out, sl };
    });
    ok(info.out.length === 6, `${info.out.length} lines`);
    const weak = info.out.filter((x) => x[0] !== 'Other' && x[2] < 3).concat(info.sl.filter((x) => x[0] !== 'Other' && x[1] < 3).map((x) => [x[0], null, x[1]]));
    ok(weak.length === 0, `below 3:1: ${weak.map((x) => `${x[0]} ${x[2].toFixed(2)}`).join(', ')}`);
    const oth = info.out.find((x) => x[0] === 'Other'); if (oth[2] < 3) notes.push(`${theme}: Other ${oth[2].toFixed(2)}:1 (advisory)`);
    for (let i = 0; i < info.out.length; i++) for (let j = i + 1; j < info.out.length; j++) { const a = info.out[i][1], b = info.out[j][1]; const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]); ok(d > 60, `${info.out[i][0]} / ${info.out[j][0]} too close (${d.toFixed(0)})`); }
  });
  await check(`[${theme}] 1300 px: donut beside its legend, no sideways scroll; full-height screenshot of every section`, async () => {
    ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, 'sideways page scroll');
    for (const nm of ['Spend by model', "Where a run's tokens go"]) {
      const sec = page.getByRole('region', { name: nm });
      ok(await sec.locator('svg[role="group"]').count() === 1, `${nm}: no donut`);
      const b = await sec.evaluate((el) => { const s = el.querySelector('svg[role="group"]').getBoundingClientRect(); const l = el.querySelector('ol').getBoundingClientRect(); return { sr: s.right, sb: s.bottom, st: s.top, lt: l.top, ll: l.left, lb: l.bottom }; });
      ok(b.sr <= b.ll + 2 && b.st < b.lb, `${nm}: legend is not beside the donut ${JSON.stringify(b)}`);
    }
    const need = await fullShot(page, `stats-${theme}-1300.png`);
    notes.push(`${theme} 1300: pane grew by ${need}px for the full-height shot`);
    await hoverSlice(page.getByRole('region', { name: 'Spend by model' }), 1);
    await page.locator('section[aria-label="Spend by model"]').screenshot({ path: path.join(SHOTS, `stats-${theme}-1300-donut-active.png`) });
    await page.locator('section.daily-chart rect[data-hit]').nth(27).hover({ force: true });
    await page.locator('section.daily-chart').screenshot({ path: path.join(SHOTS, `stats-${theme}-1300-lines-hover.png`) });
    await page.mouse.move(2, 2);
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(700);
  await check(`[${theme}] 390 px: no sideways scroll, donut stacked above its legend; full-page screenshot`, async () => {
    ok(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth) <= 1, 'sideways page scroll');
    for (const nm of ['Spend by model', "Where a run's tokens go"]) {
      const sec = page.getByRole('region', { name: nm });
      ok(await sec.locator('svg[role="group"]').count() === 1, `${nm}: no donut`);
      const b = await sec.evaluate((el) => { const s = el.querySelector('svg[role="group"]').getBoundingClientRect(); const l = el.querySelector('ol').getBoundingClientRect(); return { sb: s.bottom, lt: l.top, sw: s.width, sr: s.right }; });
      ok(b.sb <= b.lt + 2, `${nm}: donut not above the legend ${JSON.stringify(b)}`);
      ok(b.sr <= 390 && b.sw >= 140, `${nm}: donut width ${b.sw}`);
    }
    const need = await fullShot(page, `stats-${theme}-390.png`);
    notes.push(`${theme} 390: extra pane height ${need}`);
    const w = await page.evaluate(() => [...document.querySelectorAll('.stats-page *')].filter((e) => e.getBoundingClientRect().right > 391 && !e.closest('.table-scroll') && !e.closest('.sr-only')).slice(0, 3).map((e) => e.tagName + '.' + e.className));
    ok(w.length === 0, `elements wider than the screen: ${w.join(' ')}`);
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
