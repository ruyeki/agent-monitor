// Holdout e2e: app shell + Monitor (sidebar, nav, views, search, theme, stat strip, run list, answer pane, empty states, 390 px, contrast, no external requests).
// Run: WEB_DIR=<temp build> CHROME_PATH=<chrome> [HS_SHOTS=<dir>] node --disable-warning=ExperimentalWarning test/e2e/holdout-shell.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { until, mcpClient, runIdOf, req, REPO, makeRepo, STUB, started, completed } from '../holdout-codex-helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const webDir = process.env.WEB_DIR;
if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a temp build'); process.exit(2); }
if (path.resolve(webDir) === path.resolve(REPO, 'web', 'dist')) { console.error('refusing web/dist'); process.exit(2); }
const SHOTS = process.env.HS_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), 'am-hs-shots-'));
fs.mkdirSync(SHOTS, { recursive: true });

const results = []; const pageErrors = []; let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 240)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, m) => { if (!c) throw new Error(m); };
const tmpDirs = [];
const tmp = (p) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); tmpDirs.push(d); return d; };

// ---- seed: temp server, a transcript for stats, stub Codex
const projects = tmp('amx-proj-');
const tline = ({ id, ts, input = 0, output = 0, cacheWrite = 0, cacheRead = 0 }) => JSON.stringify({
  type: 'assistant', sessionId: 'sess-stats', timestamp: new Date(ts).toISOString(),
  message: { id, model: 'claude-opus-5-5-20261001', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: cacheWrite, cache_read_input_tokens: cacheRead,
    cache_creation: { ephemeral_5m_input_tokens: cacheWrite, ephemeral_1h_input_tokens: 0 } } },
});
fs.mkdirSync(path.join(projects, 'proj'), { recursive: true });
fs.writeFileSync(path.join(projects, 'proj', 'sess-stats.jsonl'), tline({ id: 's-today', ts: Date.now() - 2000, input: 100000, output: 20000, cacheWrite: 3000, cacheRead: 456 }) + '\n');

const stubDir = tmp('amx-stub-');
fs.writeFileSync(path.join(stubDir, 'script.json'), JSON.stringify({ default: { events: [started('TUI'), completed()] } }));
const root = fs.realpathSync(tmp('amx-root-'));
makeRepo(root, 'repoA');
const { startServer } = await import(new URL(`file:///${REPO}/src/server.js`).href);
const srv = await startServer({ port: 0, dataDir: tmp('amx-home-'), projectsDir: projects, webDir, usageIntervalMs: 500, codex: { command: process.execPath, args: [STUB, stubDir], root } });
const base = srv.url.replace(/\/$/, '');
const mcp = await mcpClient(srv.url);
const call = async (n, x) => (await mcp.call(n, x)).text;
const api = (m, p, o) => req(srv.port, m, p, o);
const runs = async () => (await api('GET', '/api/runs')).json;

const LONG = [
  '[CloudLab] T10.10 template requests: a new table, or a new type in the existing requests table?',
  'Background: Rohit settled the process. Chemical requests live in `requests` and are approved by an admin before any lab work starts.',
  'Proposal: a new template_requests table, reusing the Requests page and notification plumbing. Backend PR first, then the admin and client screens.',
  'Options: A = new table (recommended) / B = new type in requests',
  'Answer: Resume with A or B, or Stop run.',
].join('\n');

const T = { w1: 'Alpha gate run', w2: 'Bravo gate run', wl: 'Escalated long ask', act: 'Busy active run', fin: 'Finished done run', stp: 'Stopped run', cdx: 'Handed over run' };
const start = async (title, extra = {}) => runIdOf(await call('start_run', { title, ...extra }));
const ids = {};
ids.w1 = await start(T.w1); await call('complete_stage', { run: ids.w1, stage: 'frame', outcome: 'pass' });
ids.w2 = await start(T.w2); await call('complete_stage', { run: ids.w2, stage: 'frame', outcome: 'pass' });
ids.wl = await start(T.wl); await call('escalate', { run: ids.wl, question: LONG });
ids.act = await start(T.act);
ids.stp = await start(T.stp); await api('POST', `/api/runs/${ids.stp}/stop`, { body: {} });
ids.fin = await start(T.fin);
for (let i = 0; i < 12; i++) { // pass every stage until the run is no longer active
  const r = (await runs()).find((x) => x.id === ids.fin);
  if (!r || r.status !== 'active') break;
  const st = String(r.stage || '').split(/[ +]/)[0];
  await call('complete_stage', { run: ids.fin, stage: st, outcome: 'pass' });
}
ids.cdx = await start(T.cdx, { repo: 'repoA' });
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'PostToolUse', session_id: 'ui1', cwd: root, tool_name: 'mcp__agent-monitor__get_run', tool_input: { run: ids.cdx }, tool_response: {}, tool_use_id: 'x' } });
await req(srv.port, 'POST', '/hook', { body: { hook_event_name: 'StopFailure', session_id: 'ui1', cwd: root, error: 'rate_limit', error_details: { resetsAt: Math.floor(Date.now() / 1000) + 7200 } } });
await until(async () => (await api('GET', `/api/runs/${ids.cdx}`)).json.run?.provider === 'codex', 8000);
await until(async () => (await api('GET', '/api/stats/usage?days=30')).json?.periods?.today?.total > 0, 10000);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const externals = [];
async function newPage({ w = 1300, h = 900, scheme = 'light', theme = null, intercept } = {}) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  if (theme) await ctx.addInitScript((t) => { try { if (!sessionStorage.getItem('__seeded')) { localStorage.setItem('agent-monitor-theme', t); sessionStorage.setItem('__seeded', '1'); } } catch { /* ignore */ } }, theme);
  const p = await ctx.newPage();
  p.on('pageerror', (e) => pageErrors.push(String(e)));
  p.on('request', (r) => { const u = r.url(); if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:') && !u.startsWith('about:')) externals.push(u); });
  if (intercept) await intercept(p);
  return { ctx, p };
}
const goto = async (p, hash) => { await p.goto(`${base}/${hash}`); await p.locator('main').first().waitFor(); await p.waitForTimeout(350); };
const navLinks = (p) => p.locator('nav[aria-label="Sections"] a');
const rowOf = (p, title) => p.locator('.run-list .run-row', { hasText: title }).first();
const keyOf = (title) => Object.keys(T).find((k) => T[k] === title);
const avg = (css) => { const m = css.match(/\d+/g).map(Number); return (m[0] + m[1] + m[2]) / 3; };

const { ctx: ctxD, p: pd } = await newPage({ scheme: 'light' }); // nothing saved, OS says light: must still be dark
page = pd;
await goto(pd, '#/');
await until(async () => (await rowOf(pd, T.w1).count()) > 0, 6000);

// ---------- shell
await check('shell: aside.sidebar + one main inside .shell on all 4 pages; brand, search, kbd hint, status', async () => {
  for (const h of ['#/', '#/workflow', '#/stats', `#/runs/${ids.act}`]) {
    await goto(pd, h);
    const r = await pd.evaluate(() => ({ shell: !!document.querySelector('div.shell > aside.sidebar'), mains: document.querySelectorAll('main').length, brand: document.querySelector('.sidebar .brand')?.textContent.trim(), search: !!document.querySelector('.sidebar input[type=search][aria-label="Search runs"]'), kbd: document.querySelector('.sidebar kbd')?.textContent, sideH: document.querySelectorAll('.sidebar h1').length, foot: !!document.querySelector('.sidebar .sidebar-foot [role=status]') }));
    ok(r.shell && r.mains === 1 && /Agent Monitor/.test(r.brand || '') && r.search && /Ctrl\s*K/.test(r.kbd || '') && r.sideH === 0 && r.foot, `${h}: ${JSON.stringify(r)}`);
  }
});

await check('nav: exactly Monitor, Workflow, Stats with hrefs and icons; Monitor count = open runs; no Waiting link', async () => {
  await goto(pd, '#/');
  const items = await navLinks(pd).evaluateAll((as) => as.map((a) => [a.textContent.trim(), a.getAttribute('href')]));
  ok(items.length === 3 && /^Monitor/.test(items[0][0]) && /^Workflow/.test(items[1][0]) && /^Stats/.test(items[2][0]), JSON.stringify(items));
  ok(items.map((i) => i[1]).join() === '#/,#/workflow,#/stats', JSON.stringify(items));
  const open = (await runs()).filter((r) => ['waiting', 'active'].includes(r.status)).length;
  const c = (await navLinks(pd).first().locator('.nav-count').innerText()).trim();
  ok(Number(c) === open, `Monitor count ${c} vs open runs ${open}`);
  ok(await navLinks(pd).locator('svg[aria-hidden="true"]').count() === 3, 'each nav link needs an aria-hidden svg icon');
  ok(await pd.locator('a[href="#/waiting"]').count() === 0, 'a link to #/waiting exists');
  ok(!/^Waiting \(\d+\)$/m.test(await pd.locator('body').innerText()), 'Waiting (n) tab text present');
});

await check('nav: aria-current follows the page; run view counts as Monitor', async () => {
  const cur = (p) => navLinks(p).evaluateAll((as) => as.filter((a) => a.getAttribute('aria-current') === 'page').map((a) => a.textContent.trim().match(/^[A-Za-z]+/)[0]));
  for (const [h, want] of [['#/', 'Monitor'], ['#/workflow', 'Workflow'], ['#/stats', 'Stats'], [`#/runs/${ids.act}`, 'Monitor']]) {
    await goto(pd, h); const c = await cur(pd); ok(c.length === 1 && c[0] === want, `${h}: ${c}`);
  }
});

await check('#/waiting lands on the Monitor (no waiting page)', async () => {
  await goto(pd, '#/waiting');
  ok(await pd.getByRole('heading', { level: 1, name: 'Monitor' }).count() === 1, 'no Monitor h1');
  ok((await navLinks(pd).first().getAttribute('aria-current')) === 'page', 'Monitor not current');
});

await check('views: 3 toggle buttons with counts; filter, clear on second click, and jump to Monitor from another page', async () => {
  await goto(pd, '#/');
  const vb = pd.locator('nav[aria-label="Views"] button[type=button][aria-pressed]');
  ok(await vb.count() === 3, 'need 3 view buttons');
  const names = await vb.evaluateAll((bs) => bs.map((b) => b.textContent.trim()));
  ok(/^Waiting on you/.test(names[0]) && /^Active/.test(names[1]) && /^Finished/.test(names[2]), names.join('|'));
  ok(await pd.locator('nav[aria-label="Views"]').getByText('Views', { exact: true }).count() >= 1, 'Views heading missing');
  ok(await vb.locator('.nav-count').count() === 3, 'counts');
  const cnt = async (i) => Number((await vb.nth(i).locator('.nav-count').innerText()).trim());
  const NW = (await runs()).filter((r) => r.status === 'waiting').length;
  ok(await cnt(0) === NW, `waiting count ${await cnt(0)}`);
  await vb.nth(1).click(); await pd.waitForTimeout(250);
  ok((await vb.nth(1).getAttribute('aria-pressed')) === 'true', 'Active not pressed');
  ok(await rowOf(pd, T.act).count() === 1 && await rowOf(pd, T.w1).count() === 0, 'Active view should show only active rows');
  await vb.nth(1).click(); await pd.waitForTimeout(250);
  ok((await vb.nth(1).getAttribute('aria-pressed')) === 'false' && await rowOf(pd, T.w1).count() === 1, 'second click should clear');
  await goto(pd, '#/stats');
  await vb.nth(0).click(); await pd.waitForTimeout(300);
  ok(/#\/$/.test(pd.url()), `url ${pd.url()}`);
  ok(await rowOf(pd, T.w1).count() === 1 && await rowOf(pd, T.act).count() === 0, 'Waiting view should show only waiting');
  await vb.nth(0).click(); await pd.waitForTimeout(200);
  await vb.nth(2).click(); await pd.waitForTimeout(250);
  ok(await rowOf(pd, T.w1).count() === 0 && await rowOf(pd, T.act).count() === 0, 'Finished view should hide waiting and active rows');
  await vb.nth(2).click(); await pd.waitForTimeout(200);
});

await check('search: filters by title and id (case-insensitive); Ctrl+K focuses; Escape clears; no-match text; typing off-Monitor goes to #/', async () => {
  await goto(pd, '#/');
  const s = pd.locator('input[type=search][aria-label="Search runs"]');
  await pd.locator('main').click({ position: { x: 600, y: 10 } });
  await pd.keyboard.press('Control+k');
  ok(await s.evaluate((e) => e === document.activeElement), 'Ctrl+K did not focus search');
  await s.fill('BRAVO'); await pd.waitForTimeout(250);
  ok(await rowOf(pd, T.w2).count() === 1 && await rowOf(pd, T.w1).count() === 0 && await rowOf(pd, T.act).count() === 0, 'title filter');
  await s.fill(ids.act.toLowerCase()); await pd.waitForTimeout(250);
  ok(await rowOf(pd, T.act).count() === 1 && await rowOf(pd, T.w1).count() === 0, 'id filter');
  await s.fill('zzz-nothing'); await pd.waitForTimeout(250);
  ok((await pd.locator('main').innerText()).includes('No runs match "zzz-nothing".'), 'no-match empty state');
  await s.press('Escape'); await pd.waitForTimeout(250);
  ok((await s.inputValue()) === '' && await rowOf(pd, T.w1).count() === 1, 'Escape should clear');
  await goto(pd, '#/stats');
  await s.fill('Alpha'); await pd.waitForTimeout(400);
  ok(/#\/$/.test(pd.url()), `typing on Stats should go to #/ (url ${pd.url()})`);
  await s.fill(''); await pd.waitForTimeout(200);
});

await check('theme: empty storage + OS light => dark; button text/aria; cycle dark>light>system>dark; light persists; system follows OS', async () => {
  const { ctx, p } = await newPage({ scheme: 'light' });
  await goto(p, '#/');
  const tb = () => p.locator('.sidebar-foot button', { hasText: /^(Dark|Light|System)$/ });
  ok(await tb().count() === 1, 'theme button missing');
  ok((await tb().innerText()).trim() === 'Dark', `default text ${await tb().innerText()}`);
  ok(/^Theme: dark/i.test(await tb().getAttribute('aria-label')), await tb().getAttribute('aria-label'));
  const bg = await p.evaluate(() => getComputedStyle(document.body).backgroundColor);
  ok(avg(bg) < 40, `body bg ${bg}`);
  const seq = [];
  for (let i = 0; i < 3; i++) { await tb().click(); await p.waitForTimeout(150); seq.push((await tb().innerText()).trim()); }
  ok(seq.join() === 'Light,System,Dark', seq.join());
  await tb().click(); await p.waitForTimeout(150); // Light
  ok(avg(await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) > 200, 'light bg');
  await p.reload(); await p.locator('main').first().waitFor();
  ok((await tb().innerText()).trim() === 'Light', 'light should persist after reload');
  await tb().click(); await p.waitForTimeout(150); // System
  await p.emulateMedia({ colorScheme: 'dark' }); await p.waitForTimeout(200);
  ok(avg(await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) < 40, 'System + OS dark should be dark');
  await p.emulateMedia({ colorScheme: 'light' }); await p.waitForTimeout(200);
  ok(avg(await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) > 200, 'System + OS light should be light');
  await ctx.close();
});

// ---------- Monitor
await goto(pd, '#/');
await check('monitor: page-head h1 "Monitor" with "Updated <time>"; Live status in the sidebar; one h1', async () => {
  const hd = pd.locator('main header.page-head').first();
  ok(await hd.getByRole('heading', { level: 1, name: 'Monitor' }).count() === 1, 'h1');
  ok(/Updated\s+\S+/.test(await hd.innerText()), `head text: ${await hd.innerText()}`);
  ok(/Live/.test(await pd.locator('.sidebar-foot [role=status]').innerText()), 'Live status');
  ok(await pd.locator('h1').count() === 1, 'exactly one h1 on the page');
});

const tileText = async (p, label) => (await p.locator('section.stat-strip[aria-label="Today"] .stat', { hasText: label }).first().innerText()).replace(/\s+/g, ' ');
await check('stat strip: 4 tiles with the exact labels; values match runs and usage stats', async () => {
  ok(await pd.locator('section.stat-strip[aria-label="Today"] .stat').count() === 4, 'need 4 tiles');
  const all = await runs();
  const act = all.filter((r) => r.status === 'active').length, wt = all.filter((r) => r.status === 'waiting').length;
  for (const l of ['Active runs', 'Waiting on you', 'Tokens today', 'Cost today']) ok(await pd.locator('section.stat-strip .stat', { hasText: l }).count() >= 1, `label ${l}`);
  ok(new RegExp(`Active runs\\s*${act}\\b`).test(await tileText(pd, 'Active runs')), `Active tile: ${await tileText(pd, 'Active runs')} want ${act}`);
  ok(new RegExp(`Waiting on you\\s*${wt}\\b`).test(await tileText(pd, 'Waiting on you')), `Waiting tile: ${await tileText(pd, 'Waiting on you')} want ${wt}`);
  ok(/Tokens today\s*123k/.test(await tileText(pd, 'Tokens today')), `Tokens tile: ${await tileText(pd, 'Tokens today')}`);
  ok(/Cost today\s*\$\d/.test(await tileText(pd, 'Cost today')), `Cost tile: ${await tileText(pd, 'Cost today')}`);
});

await check('stat strip: en dash for tokens and cost when the stats endpoint fails; run tiles still render', async () => {
  const { ctx, p } = await newPage({ intercept: (pp) => pp.route('**/api/stats/usage**', (r) => r.fulfill({ status: 500, body: 'boom' })) });
  await goto(p, '#/'); await p.waitForTimeout(500);
  ok(/Tokens today\s*–/.test(await tileText(p, 'Tokens today')), `Tokens: ${await tileText(p, 'Tokens today')}`);
  ok(/Cost today\s*–/.test(await tileText(p, 'Cost today')), `Cost: ${await tileText(p, 'Cost today')}`);
  ok(await p.locator('section.stat-strip .stat', { hasText: 'Active runs' }).count() === 1, 'run tiles still render');
  await ctx.close();
});

await check('runs list: groups Waiting on you / Active / Finished in order with counts; Finished is collapsed details', async () => {
  const norm = (await pd.locator('.run-list h2.group-head').allInnerTexts()).map((h) => h.replace(/\s+/g, ' ').trim());
  ok(norm.length === 3 && /^Waiting on you\b/.test(norm[0]) && /^Active\b/.test(norm[1]) && /^Finished\b/.test(norm[2]), norm.join('|'));
  const NW0 = (await runs()).filter((r) => r.status === "waiting").length;
  ok(new RegExp('\\b' + NW0 + '\\b').test(norm[0]), `waiting head ${norm[0]}`);
  ok(await pd.locator('.run-list details.finished').evaluate((d) => !d.open), 'Finished should be collapsed by default');
  ok(await pd.locator('.run-list details.finished > summary h2.group-head').count() === 1, 'finished head in summary');
  await pd.locator('.run-list details.finished > summary').click(); await pd.waitForTimeout(200);
  ok(await rowOf(pd, T.stp).count() === 1, 'stopped run listed under Finished');
});

await check('rows: status icon aria-label, mono id, stage pill, rounds n/max, age; waiting rows are buttons, others links', async () => {
  const want = [[T.w1, 'Waiting on you', 'button'], [T.act, 'Running', 'a'], [T.stp, 'Stopped', 'a']];
  const fin = (await runs()).find((r) => r.id === ids.fin);
  if (fin && fin.status === 'done') want.push([T.fin, 'Done', 'a']);
  for (const [title, label, tag] of want) {
    const info = await rowOf(pd, title).evaluate((e) => ({ tag: e.tagName.toLowerCase(), icon: e.querySelector('svg[role=img]')?.getAttribute('aria-label'), mono: e.querySelector('.mono')?.textContent.trim(), pill: e.querySelector('.stage-pill')?.textContent.trim(), txt: e.innerText, pressed: e.getAttribute('aria-pressed'), href: e.getAttribute('href') }));
    const id = ids[keyOf(title)];
    ok(info.tag === tag && info.icon === label, `${title}: ${JSON.stringify(info)}`);
    ok(info.mono === id, `${title}: mono id ${info.mono}`);
    ok(info.pill && info.pill.length > 0, `${title}: stage pill`);
    ok(/\b\d+\/\d+\b/.test(info.txt), `${title}: rounds in "${info.txt.replace(/\s+/g, ' ')}"`);
    ok(/(\bnow\b|\bago\b|\d+\s?(s|m|h|d)\b)/i.test(info.txt), `${title}: age in "${info.txt.replace(/\s+/g, ' ')}"`);
    if (tag === 'button') ok(info.pressed === 'true' || info.pressed === 'false', 'aria-pressed on waiting row');
    else ok(info.href === `#/runs/${id}`, `href ${info.href}`);
  }
});

await check('rows: the Codex run shows the Codex tag in the list', async () => {
  ok(/codex/i.test(await rowOf(pd, T.cdx).innerText()), `row: ${(await rowOf(pd, T.cdx).innerText()).replace(/\s+/g, ' ')}`);
});

await check('rows: icons differ per state in shape and colour (never colour alone)', async () => {
  const icons = await pd.locator('.run-list .run-row svg[role=img]').evaluateAll((els) => els.map((e) => ({ l: e.getAttribute('aria-label'), c: [getComputedStyle(e).color, getComputedStyle(e).fill, getComputedStyle(e).stroke].join('|'), shape: e.innerHTML.replace(/\s+/g, ' ') })));
  const by = {}; for (const i of icons) by[i.l] = i;
  ok(by['Waiting on you'] && by.Running && by.Stopped, `labels ${Object.keys(by)}`);
  ok(by['Waiting on you'].shape !== by.Running.shape && by.Running.shape !== by.Stopped.shape && by['Waiting on you'].shape !== by.Stopped.shape, 'icon shapes should differ per state');
  ok(by['Waiting on you'].c !== by.Running.c && by.Running.c !== by.Stopped.c, 'icon colours should differ per state');
});

// ---------- answer pane
const pane = () => pd.locator('aside.answer-pane[aria-label="Selected run"]');
await check('pane: first waiting run selected by default; card, Open run link; pane beside the list on a wide screen', async () => {
  await goto(pd, '#/');
  await until(async () => (await pane().locator('article').count()) > 0, 5000);
  const first = pd.locator('.run-list button.run-row').first();
  ok((await first.getAttribute('aria-pressed')) === 'true', 'first waiting row not pressed');
  const art = await pane().locator('article').first().getAttribute('aria-label');
  ok(/^Waiting on you: /.test(art) && (await first.innerText()).includes(art.replace('Waiting on you: ', '')), `article ${art}`);
  ok(await pane().getByRole('link', { name: /Open run/ }).count() === 1, 'Open run link');
  const pw = (await pane().boundingBox()).width, lw = (await pd.locator('.run-list').boundingBox()).width;
  ok(pw > 250 && pw < 520 && lw > pw, `pane ${pw} list ${lw}`);
});

await check('pane: clicking another waiting row selects it (aria-pressed, pane content, URL stays #/)', async () => {
  await rowOf(pd, T.wl).click(); await pd.waitForTimeout(300);
  ok((await rowOf(pd, T.wl).getAttribute('aria-pressed')) === 'true', 'long-ask row not pressed');
  ok(await pane().locator(`article[aria-label="Waiting on you: ${T.wl}"]`).count() === 1, 'pane did not switch');
  ok((await rowOf(pd, T.w1).getAttribute('aria-pressed')) === 'false', 'old row still pressed');
  ok(/#\/$/.test(pd.url()), `url ${pd.url()}`);
});

await check('pane: long multi-line ask is formatted (bold labels, inline code) and does not overflow the pane', async () => {
  const info = await pane().locator('article').first().evaluate((e) => {
    const lab = e.querySelector('.ask-label'), txt = e.querySelector('.ask-text');
    return { labels: [...e.querySelectorAll('.ask-label')].map((x) => x.textContent.trim()), lw: lab && parseInt(getComputedStyle(lab).fontWeight, 10), tw: txt && parseInt(getComputedStyle(txt).fontWeight, 10), code: e.querySelectorAll('code').length, sw: e.scrollWidth, cw: e.clientWidth, paneSw: e.closest('aside').scrollWidth, paneCw: e.closest('aside').clientWidth };
  });
  ok(['Background', 'Proposal', 'Options'].every((w) => info.labels.some((l) => l.includes(w))), `labels ${info.labels}`);
  ok(info.lw > info.tw, `label weight ${info.lw} vs text ${info.tw}`);
  ok(info.code >= 1, 'inline code rendered');
  ok(info.sw <= info.cw + 1 && info.paneSw <= info.paneCw + 1, `overflow ${JSON.stringify(info)}`);
});

await check('pane: labelled reply textarea, action buttons with only the first primary, Open run link target', async () => {
  const a = pane().locator('article').first();
  ok(await a.getByRole('textbox', { name: `Reply for ${T.wl}` }).count() === 1, 'reply textarea');
  const btns = await pane().locator('button').evaluateAll((bs) => bs.map((b) => [b.textContent.trim(), b.classList.contains('primary')]));
  ok(btns.length >= 2, `buttons ${JSON.stringify(btns)}`);
  ok(btns[0][1] === true && btns.slice(1).every((b) => !b[1]), `primary only on the first action: ${JSON.stringify(btns)}`);
  ok((await pane().getByRole('link', { name: /Open run/ }).getAttribute('href')) === `#/runs/${ids.wl}`, 'Open run href');
});

await check('pane: an action posts, the run leaves the waiting list and the pane falls back to another waiting run', async () => {
  const before = (await runs()).filter((r) => r.status === 'waiting').length;
  await rowOf(pd, T.w1).click(); await pd.waitForTimeout(250);
  const art = pane().locator(`article[aria-label="Waiting on you: ${T.w1}"]`);
  const actName = (await art.locator('button').first().innerText()).trim();
  await art.locator('button').first().click();
  await until(async () => (await runs()).filter((r) => r.status === 'waiting').length < before, 6000);
  await until(async () => (await pd.locator('.run-list button.run-row', { hasText: T.w1 }).count()) === 0, 6000);
  ok(await pd.locator('.run-list button.run-row', { hasText: T.w1 }).count() === 0, `${T.w1} still a waiting row after "${actName}"`);
  ok(await pane().locator(`article[aria-label="Waiting on you: ${T.w1}"]`).count() === 0, 'pane still shows the answered run');
  ok(await pane().locator('article').count() === 1, 'pane should fall back to another waiting run');
  const ww = Number((await pd.locator('nav[aria-label="Views"] button').first().locator('.nav-count').innerText()).trim());
  ok(ww === before - 1, `Views waiting count ${ww} want ${before - 1}`);
});

await check('clicking an active row opens #/runs/<id> inside the shell', async () => {
  await rowOf(pd, T.act).click(); await pd.waitForTimeout(500);
  ok(pd.url().endsWith(`#/runs/${ids.act}`), pd.url());
  ok(await pd.locator('div.shell > aside.sidebar').count() === 1, 'shell on run view');
});

await check('run view / workflow / stats: one page-head h1 inside main; run header has title, id, Back to monitor; Publish kept', async () => {
  for (const [h, t] of [[`#/runs/${ids.act}`, T.act], ['#/workflow', 'Workflow'], ['#/stats', 'Stats']]) {
    await goto(pd, h);
    const r = await pd.evaluate(() => { const h1 = document.querySelectorAll('h1'); return { n: h1.length, inMain: !!document.querySelector('main header.page-head h1'), text: h1[0]?.textContent.trim() }; });
    ok(r.n === 1 && r.inMain && r.text.includes(t), `${h}: ${JSON.stringify(r)}`);
  }
  await goto(pd, `#/runs/${ids.act}`);
  const rv = await pd.locator('main header.page-head').first().innerText();
  ok(/Back to monitor/.test(rv) && rv.includes(ids.act), `run header: ${rv.replace(/\s+/g, ' ')}`);
  await goto(pd, '#/workflow');
  ok(await pd.getByRole('button', { name: /Publish/ }).count() >= 1, 'Publish button missing on Workflow');
});

await check('run view of a waiting run still shows the waiting card', async () => {
  await goto(pd, `#/runs/${ids.wl}`);
  ok(await pd.locator(`article[aria-label="Waiting on you: ${T.wl}"]`).count() === 1, 'waiting card missing in run view');
});

// ---------- empty states, on a fresh server
await check('empty states: no runs => "No runs yet."; nothing waiting => "Nothing is waiting on you."', async () => {
  const s2 = await startServer({ port: 0, dataDir: tmp('amx-home2-'), projectsDir: tmp('amx-proj2-'), webDir });
  const { ctx, p } = await newPage();
  await p.goto(`${s2.url.replace(/\/$/, '')}/#/`); await p.locator('main').first().waitFor(); await p.waitForTimeout(600);
  const t = await p.locator('main').innerText();
  ok(t.includes('No runs yet.'), `empty: ${t.replace(/\s+/g, ' ').slice(0, 200)}`);
  ok(t.includes('Nothing is waiting on you.'), 'pane empty message');
  await ctx.close(); await s2.close();
});

// ---------- 390 px
for (const theme of ['light', 'dark']) {
  await check(`[${theme}] 390 px: sidebar stacked on top, pane below the list, no sideways scroll on any page`, async () => {
    const { ctx, p } = await newPage({ w: 390, h: 800, scheme: theme, theme });
    for (const h of ['#/', '#/workflow', '#/stats', `#/runs/${ids.act}`, `#/runs/${ids.wl}`]) {
      await goto(p, h);
      const r = await p.evaluate(() => { const m = document.querySelector('main'); return { doc: document.documentElement.scrollWidth - document.documentElement.clientWidth, body: document.body.scrollWidth - document.body.clientWidth, main: m.scrollWidth - m.clientWidth }; });
      ok(r.doc <= 0 && r.body <= 0 && (h === '#/workflow' || r.main <= 0), `${h}: overflow ${JSON.stringify(r)}`);
    }
    await goto(p, '#/');
    await until(async () => (await p.locator('aside.answer-pane article').count()) > 0, 5000);
    const g = await p.evaluate(() => { const sb = document.querySelector('.sidebar').getBoundingClientRect(), mn = document.querySelector('main').getBoundingClientRect(), l = document.querySelector('.run-list').getBoundingClientRect(), pn = document.querySelector('.answer-pane').getBoundingClientRect(); return { sbBottom: sb.bottom, sbW: sb.width, mainTop: mn.top, listBottom: l.bottom, paneTop: pn.top, paneW: pn.width, vw: innerWidth }; });
    ok(g.sbW >= g.vw - 2 && g.mainTop >= g.sbBottom - 2, `sidebar not stacked on top: ${JSON.stringify(g)}`);
    ok(g.paneTop >= g.listBottom - 2 && g.paneW >= g.vw * 0.8, `pane not below list: ${JSON.stringify(g)}`);
    await ctx.close();
  });
}

// ---------- contrast on Monitor
const contrastIn = () => {
  const cv = document.createElement('canvas'); cv.width = cv.height = 1;
  const g = cv.getContext('2d', { willReadFrequently: true });
  const rgba = (s) => { g.clearRect(0, 0, 1, 1); g.fillStyle = '#000'; g.fillStyle = s; g.fillRect(0, 0, 1, 1); const d = g.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (t, b) => { const a = t[3]; return [t[0] * a + b[0] * (1 - a), t[1] * a + b[1] * (1 - a), t[2] * a + b[2] * (1 - a), 1]; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  const bgOf = (el) => { let bg = [255, 255, 255, 1]; const ch = []; for (let e = el; e; e = e.parentElement) ch.push(e); for (const e of ch.reverse()) { const c = rgba(getComputedStyle(e).backgroundColor); if (c[3] > 0) bg = over(c, bg); } return bg; };
  const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity); return o; };
  const bad = []; let n = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.sr-only')) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || cs.display === 'none') continue;
    let text = ''; for (const c of el.childNodes) if (c.nodeType === 3) text += c.textContent;
    if (['INPUT', 'TEXTAREA'].includes(el.tagName)) text = el.value || '';
    if (!text.trim() || el.matches(':disabled')) continue;
    const r = el.getBoundingClientRect(); if (!r.width || !r.height) continue;
    const bg = bgOf(el); const fg = rgba(el instanceof SVGElement ? cs.fill : cs.color); fg[3] *= opacity(el);
    const eff = fg[3] < 1 ? over(fg, bg) : fg;
    const size = parseFloat(cs.fontSize), w = parseInt(cs.fontWeight, 10), large = size >= 24 || (size >= 18.66 && w >= 700);
    const a = lum(eff), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05); n++;
    if (ratio < (large ? 3 : 4.5)) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 20)} "${text.trim().slice(0, 20)}" ${ratio.toFixed(2)}`);
  }
  return { n, bad };
};
for (const theme of ['light', 'dark']) {
  await check(`[${theme}] Monitor text contrast >= 4.5:1 (list, pane, tiles, sidebar, hovered row)`, async () => {
    const { ctx, p } = await newPage({ scheme: theme, theme });
    await goto(p, '#/');
    await until(async () => (await p.locator('aside.answer-pane article').count()) > 0, 5000);
    await p.locator('.run-list details.finished > summary').click().catch(() => {});
    await p.waitForTimeout(300);
    const r1 = await p.evaluate(contrastIn);
    await p.locator('.run-list .run-row').nth(1).hover(); await p.waitForTimeout(200);
    const r2 = await p.evaluate(contrastIn);
    const bad = [...new Set([...r1.bad, ...r2.bad])];
    await p.screenshot({ path: path.join(SHOTS, `monitor-${theme}.png`) });
    await ctx.close();
    ok(r1.n > 30 && !bad.length, `n=${r1.n} bad: ${bad.slice(0, 8).join(' | ')}`);
  });
}

await check('no external or font requests on any page; no page errors', async () => {
  for (const h of ['#/', '#/workflow', '#/stats', `#/runs/${ids.act}`]) await goto(pd, h);
  ok(!externals.length, `external requests: ${[...new Set(externals)].slice(0, 5).join(', ')}`);
  ok(!pageErrors.length, `page errors: ${pageErrors.slice(0, 2).join(' | ')}`);
});

await browser.close();
try { await mcp.client.close(); } catch { /* ignore */ }
await srv.close();
for (const d of tmpDirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ } }
let fails = 0;
for (const [n, s, d] of results) { if (s !== 'PASS') fails++; console.log(`${s}  ${n}${d ? '\n      ' + d : ''}`); }
console.log(`\n${results.length - fails}/${results.length} passed. Shots: ${SHOTS}`);
process.exit(fails ? 1 : 0);
