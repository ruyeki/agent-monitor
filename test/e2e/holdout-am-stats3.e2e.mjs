// Guards the Stats first-load animation (#2266) in a real browser on a built bundle with seeded data.
// Run: WEB_DIR=<built dist> CHROME_PATH=<chromium> [AM_STATS_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-am-stats3.e2e.mjs
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
async function newPage({ theme = 'dark', width = 1300, height = 900, reduced = false } = {}) {
  const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, reducedMotion: reduced ? 'reduce' : 'no-preference' });
  await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* */ } }, theme);
  ctx.setDefaultTimeout(4000);
  const p = await ctx.newPage();
  p.on('request', (r) => requests.push(r.url()));
  p.on('pageerror', (e) => pageErrors.push(String(e)));
  return { ctx, p };
}
// Wait only until the daily lines exist (no settling sleep): the intro window is short.
const openFast = async (p, hash = '#/stats') => {
  await p.goto(`${base}/${hash}`);
  await p.locator('section.daily-chart path.series-line').first().waitFor({ timeout: 10000 });
  return Date.now();
};
const anims = (p) => p.evaluate(() => document.getAnimations().filter((a) => typeof a.animationName === 'string').map((a) => ({ name: a.animationName || null, dur: a.effect?.getTiming().duration, delay: a.effect?.getTiming().delay, state: a.playState })));
const markers = (p) => p.evaluate(() => ({
  intro: document.querySelectorAll('.intro').length, mask: document.querySelectorAll('mask, [mask]').length,
  pathLength: [...document.querySelectorAll('path.series-line')].filter((e) => e.hasAttribute('pathLength')).length,
  dash: [...document.querySelectorAll('path.series-line')].filter((e) => { const d = getComputedStyle(e).strokeDasharray; return d && d !== 'none'; }).length,
  lines: document.querySelectorAll('path.series-line').length, slices: document.querySelectorAll('path[data-slice]').length,
}));
const sizes = (p) => p.evaluate(() => [...document.querySelectorAll('section.daily-chart svg[role="img"], .donut svg, section[aria-label="Runs"] svg[role="img"]')].map((s) => { const r = s.getBoundingClientRect(); return [s.closest('section')?.getAttribute('aria-label') || s.closest('section')?.className, Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10]; }));
const settleAnims = async (p, ms = 2600) => { await p.waitForTimeout(ms); };
const btn = (p, group, name) => p.getByRole('group', { name: group }).getByRole('button', { name });
const names = (a) => new Set(a.map((x) => x.name).filter(Boolean));

let { ctx, p } = await newPage();
page = p;

await check('right after load: stats-draw, stats-sweep and stats-fade are running with the specified durations and a 60 ms line stagger', async () => {
  await openFast(page);
  await page.locator('.donut-wrap').nth(1).waitFor({ timeout: 6000 });
  const a = await anims(page);
  const n = names(a);
  ok(n.has('stats-draw') && n.has('stats-sweep') && n.has('stats-fade'), `animations: ${[...n].join(',') || 'none'}`);
  const draws = a.filter((x) => x.name === 'stats-draw');
  ok(draws.length >= 4, `${draws.length} draw animations (daily lines + runs line)`);
  ok(draws.every((x) => x.dur === 700), `draw durations ${[...new Set(draws.map((x) => x.dur))]}`);
  ok(a.filter((x) => x.name === 'stats-sweep').every((x) => x.dur === 700), 'sweep duration');
  ok(a.filter((x) => x.name === 'stats-sweep').length === 2, 'two donuts sweep');
  ok(a.filter((x) => x.name === 'stats-fade').every((x) => x.dur === 400 && x.delay === 200), 'fade timing');
  const delays = [...new Set(draws.map((x) => Math.round(x.delay)))].sort((x, y) => x - y);
  ok(delays[0] === 0 && delays.length >= 3 && delays.every((d) => d % 60 === 0), `line delays ${delays}`);
});

await check('about 2 s later nothing animates and the final state is plain (no dash, mask, pathLength, intro class)', async () => {
  await settleAnims(page);
  const a = await anims(page);
  ok(a.length === 0, `still animating: ${a.map((x) => x.name).join(',')}`);
  const m = await markers(page);
  ok(m.intro === 0 && m.mask === 0 && m.pathLength === 0 && m.dash === 0, JSON.stringify(m));
  ok(m.lines >= 4 && m.slices >= 6, `chart marks missing ${JSON.stringify(m)}`);
});

await check('a metric switch, a split switch and a range switch start no animation', async () => {
  for (const go of [() => btn(page, 'Metric', 'Tokens').click(), () => btn(page, 'Split', 'By token type').click(), () => btn(page, 'Split', 'By model').click(), () => btn(page, 'Range', '7 days').click(), () => btn(page, 'Range', '30 days').click(), () => btn(page, 'Metric', 'Cost').click()]) {
    await go();
    for (let i = 0; i < 4; i++) { await page.waitForTimeout(120); const a = await anims(page); ok(a.length === 0, `animation after a switch: ${a.map((x) => x.name).join(',')}`); }
  }
  const m = await markers(page);
  ok(m.intro === 0 && m.mask === 0 && m.dash === 0 && m.pathLength === 0, JSON.stringify(m));
});

await check('a version switch after the window does not replay the stage donut', async () => {
  const v = page.getByRole('region', { name: "Where a run's tokens go" }).getByRole('group', { name: 'Version' });
  if (await v.count() === 0) { notes.push('only one version: version-switch check skipped'); return; }
  const bs = v.getByRole('button');
  for (let i = 0; i < await bs.count(); i++) { await bs.nth(i).click(); await page.waitForTimeout(150); const a = await anims(page); ok(a.length === 0, 'animation after version switch'); ok((await markers(page)).mask === 0, 'mask after version switch'); }
});

await check('a live refresh after the intro starts no animation', async () => {
  const cnt = () => page.evaluate(() => performance.getEntriesByType('resource').filter((e) => e.name.includes('/api/stats/usage')).length);
  const before = await cnt();
  await call('start_run', { title: 'Live refresh run' });
  const got = await until(async () => (await cnt()) > before, 42000, 250);
  ok(got, 'no live refetch within 42 s');
  const t0 = Date.now();
  while (Date.now() - t0 < 1500) { const a = await anims(page); ok(a.length === 0, `animation after refresh: ${a.map((x) => x.name).join(',')}`); await page.waitForTimeout(100); }
  const m = await markers(page);
  ok(m.intro === 0 && m.mask === 0 && m.dash === 0, JSON.stringify(m));
});

await check('leaving and re-entering #/stats replays the intro (draw, sweep, fade)', async () => {
  await page.evaluate(() => { location.hash = '#/'; });
  await page.waitForTimeout(500);
  ok(await page.locator('section.daily-chart').count() === 0, 'still on stats');
  await page.evaluate(() => { location.hash = '#/stats'; });
  await page.locator('section.daily-chart path.series-line').first().waitFor({ timeout: 8000 });
  await page.locator('.donut-wrap').nth(1).waitFor({ timeout: 6000 });
  const n = names(await anims(page));
  ok(n.has('stats-draw') && n.has('stats-sweep') && n.has('stats-fade'), `replay animations: ${[...n].join(',') || 'none'}`);
  await settleAnims(page);
  ok((await anims(page)).length === 0, 'replay did not end');
});

await ctx.close();

await check('slice dimming and the line hover guide and dots work during the animation; chart boxes keep their size from first paint to the end', async () => {
  ({ ctx, p } = await newPage()); page = p;
  await openFast(page);
  await page.locator('.donut-wrap').nth(1).waitFor({ timeout: 6000 });
  const first = await sizes(page);
  const running = (await anims(page)).length;
  ok(running > 0, 'no animation to test against');
  await page.locator('section.daily-chart rect[data-hit]').nth(25).hover({ force: true });
  ok(await page.locator('section.daily-chart line.guide').count() === 1, 'no guide during the intro');
  ok(await page.locator('section.daily-chart circle.dot').count() > 0, 'no dots during the intro');
  const sec = page.locator('section[aria-label="Spend by model"]');
  await sec.locator('ol.donut-legend li').nth(1).hover();
  const dimmed = await until(async () => sec.locator('path[data-slice]').evaluateAll((els) => els.filter((e) => parseFloat(getComputedStyle(e).opacity) < 0.6).length), 1000, 50);
  ok(dimmed >= 2, `${dimmed} slices dimmed while hovering a legend row`);
  ok(await sec.locator('ol.donut-legend li.active').count() === 1, 'no active legend row');
  await page.mouse.move(5, 5);
  await settleAnims(page);
  const last = await sizes(page);
  ok(first.length === last.length && first.every((f, i) => Math.abs(f[1] - last[i][1]) <= 1 && Math.abs(f[2] - last[i][2]) <= 1), `chart boxes changed ${JSON.stringify(first)} -> ${JSON.stringify(last)}`);
});
await ctx.close();

await check('reduced motion: nothing animates at any point, no intro markers, final marks drawn; a forced .intro class still does nothing', async () => {
  ({ ctx, p } = await newPage({ reduced: true })); page = p;
  await openFast(page);
  await page.locator('.donut-wrap').nth(1).waitFor({ timeout: 6000 });
  for (let i = 0; i < 6; i++) { const a = await anims(page); ok(a.length === 0, `animating under reduced motion: ${a.map((x) => x.name).join(',')}`); await page.waitForTimeout(150); }
  const m = await markers(page);
  ok(m.intro === 0 && m.mask === 0 && m.pathLength === 0 && m.dash === 0 && m.lines >= 4 && m.slices >= 6, JSON.stringify(m));
  await page.evaluate(() => { document.querySelectorAll('section.daily-chart svg g, .donut-wrap').forEach((g) => g.classList.add('intro')); });
  await page.waitForTimeout(100);
  ok((await anims(page)).length === 0, 'CSS plays the intro under reduced motion');
});
await ctx.close();

// frames: tall viewport so the whole pane is visible without scrolling; the mid frame pauses every animation at 300 ms
for (const theme of ['dark', 'light']) {
  await check(`frames ${theme}: mid-animation and final shots of #/stats at 1300 px`, async () => {
    ({ ctx, p } = await newPage({ theme, width: 1300, height: 2600 })); page = p;
    await openFast(page);
    await page.locator('.donut-wrap').nth(1).waitFor({ timeout: 6000 });
    const paused = await page.evaluate(() => { const a = document.getAnimations().filter((x) => typeof x.animationName === 'string'); a.forEach((x) => { x.pause(); x.currentTime = 300; }); return a.length; });
    ok(paused > 0, 'nothing to pause for the mid frame');
    await page.screenshot({ path: path.join(SHOTS, `stats-${theme}-mid.png`), fullPage: true });
    await page.waitForTimeout(2200);
    const need = await page.evaluate(() => { let e = document.querySelector('.stats-page'); while (e && !(e.scrollHeight > e.clientHeight + 5 && /(auto|scroll)/.test(getComputedStyle(e).overflowY))) e = e.parentElement; return e && e !== document.documentElement ? e.scrollHeight - e.clientHeight : 0; });
    notes.push(`${theme}: pane still needs ${need} px of scrolling at 2600 px viewport`);
    await page.screenshot({ path: path.join(SHOTS, `stats-${theme}-final.png`), fullPage: true });
    await ctx.close();
  });
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
