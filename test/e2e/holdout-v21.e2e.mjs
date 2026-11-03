// Holdout e2e for Agent Monitor v2.1 (AC1-AC6) against a temp server. Run:
//   WEB_DIR=<temp build> node --disable-warning=ExperimentalWarning test/e2e/holdout-v21.e2e.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { boot, mcpClient, runIdOf, until, hook, load, REPO } from './helpers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'am-v21-shots-'));
const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const results = [];
const notes = [];
const pageErrors = [];
const dialogs = [];
let page;
async function check(name, fn) {
  try { await fn(); results.push([name, 'PASS', '']); } catch (e) {
    results.push([name, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 260)]);
    try { await page.screenshot({ path: path.join(SHOTS, `FAIL-${name.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
  }
}
const ok = (c, msg) => { if (!c) throw new Error(msg); };
const webDir = process.env.WEB_DIR || path.join(REPO, 'web', 'dist');
ok(fs.existsSync(path.join(webDir, 'index.html')), 'no built app at ' + webDir);
const { formatTokens, formatDuration } = await load('web/src/lib/format.js');

// ---- server + fixture runs
const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'am-v21-proj-'));
const app = await boot({ webDir, projects });
const base = app.url.replace(/\/$/, '');
const get = async (p) => (await app.api('GET', p)).json;
const mcp = await mcpClient(app.url);
const call = async (name, args) => (await mcp.call(name, args)).text;
const SESSION = 'sess-v21';
const rp = (s) => path.join(projects, 'proj', `${s}.jsonl`);
const tline = (id, agent, ts, input, output) => JSON.stringify({ type: 'assistant', sessionId: SESSION, agentId: agent, timestamp: new Date(ts).toISOString(),
  message: { id, model: 'claude-sonnet-5-5-20261001', role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } } });
const sub = (a) => path.join(projects, 'proj', SESSION, 'subagents', `agent-${a}.jsonl`);

const start = async (title) => runIdOf(await call('start_run', { title }));
const done = (run, stage, outcome = 'done') => call('complete_stage', { run, stage, outcome });
const answer = (run, action) => call('respond', { run, action });
const toVerify = async (run) => {
  await done(run, 'frame'); await answer(run, 'Agree spec'); await done(run, 'plan');
  await done(run, 'implement'); await done(run, 'prep');
};

// 1. Run RB waits at gate1 (amber). Nothing has finished: every published node must say "no runs yet".
const RB = await start('Waiting run');
await done(RB, 'frame');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const newPage = async (scheme) => {
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: scheme });
  const p = await ctx.newPage();
  p.on('dialog', async (d) => { dialogs.push(d.message()); await d.dismiss(); });
  p.on('pageerror', (e) => pageErrors.push(String(e)));
  return { ctx, p };
};
let cur = await newPage('light');
page = cur.p;
await page.goto(`${base}/#/workflow`);
const waitCards = async () => { await page.locator('.fnode[data-node="frame"]').waitFor({ timeout: 10000 }); await page.waitForTimeout(700); };
await waitCards();

const effectiveNameSizes = () => page.evaluate(() => {
  const vp = document.querySelector('.react-flow__viewport');
  const m = new DOMMatrixReadOnly(getComputedStyle(vp).transform);
  const scale = Math.hypot(m.a, m.b);
  return { scale, sizes: [...document.querySelectorAll('.fnode-name')].map((n) => parseFloat(getComputedStyle(n).fontSize) * scale), count: document.querySelectorAll('.fnode-name').length };
});

// ---- AC4 first: no finished runs yet
await check('AC4 editor: "no runs yet" on every node of the published version before any run finishes', async () => {
  const v = (await get('/api/workflow')).published.version;
  const sv = (await get('/api/stats/versions')).find((x) => x.version === v);
  ok(sv && sv.finishedRuns === 0, 'precondition: version has no finished runs');
  ok(await until(async () => (await page.locator('.fnode-stats').allInnerTexts()).length >= 15, 6000), `stats lines missing (${await page.locator('.fnode-stats').count()})`);
  const texts = await page.locator('.fnode-stats').allInnerTexts();
  ok(texts.every((t) => /no runs yet/i.test(t)), `not all "no runs yet": ${texts.slice(0, 3).join(' | ')}`);
  ok((await page.locator('.fnode[data-node="split"] .fnode-stats, .fnode[data-node="join"] .fnode-stats').count()) === 0, 'split/join show a stats line');
});

// ---- AC1 editor
await check('AC1 editor: names >= 12 px effective at the initial fit-to-view (seed, 1500x950)', async () => {
  const r = await effectiveNameSizes();
  ok(r.count >= 17, `only ${r.count} names`);
  const min = Math.min(...r.sizes);
  ok(min >= 11.95, `smallest effective name size ${min.toFixed(2)} px (zoom ${r.scale.toFixed(2)})`);
});
await check('AC1 editor: names >= 12 px after pressing the Controls fit-view button', async () => {
  await page.locator('.react-flow__controls-fitview').click();
  await page.waitForTimeout(900);
  const r = await effectiveNameSizes();
  const min = Math.min(...r.sizes);
  ok(min >= 11.95, `smallest effective name size ${min.toFixed(2)} px (zoom ${r.scale.toFixed(2)})`);
});
// ---- AC2 editor
await check('AC2: every card has top target and bottom source handles; no left/right; end nodes no source', async () => {
  const r = await page.evaluate(() => [...document.querySelectorAll('.fnode')].map((n) => ({
    id: n.dataset.node, top: !!n.querySelector('.react-flow__handle-top'), bottom: !!n.querySelector('.react-flow__handle-bottom'),
    left: !!n.querySelector('.react-flow__handle-left'), right: !!n.querySelector('.react-flow__handle-right'),
  })));
  ok(r.length >= 17, 'cards missing');
  ok(r.every((x) => !x.left && !x.right), 'a card still has a left/right handle');
  ok(r.every((x) => x.top), 'a card has no top handle');
  ok(r.filter((x) => !['done', 'stopped'].includes(x.id)).every((x) => x.bottom), 'a non-end card has no bottom handle');
  ok(r.filter((x) => ['done', 'stopped'].includes(x.id)).every((x) => !x.bottom), 'an end card has a source handle');
});
await check('AC2: edge labels are the outcome/action only; fixRound edges are dashed (class edge-fix)', async () => {
  const wf = (await get('/api/workflow')).draft.workflow;
  const labels = (await page.locator('.react-flow__edge-text').evaluateAll((els) => els.map((e) => e.textContent.trim()))).filter(Boolean);
  ok(labels.length >= 15, `only ${labels.length} edge labels`);
  ok(!labels.some((l) => /fix round/i.test(l)), 'a label still says "(fix round)"');
  // rule: edges sharing from>to form a group; the first edge carries the group's `on` values joined by " / "; others unlabelled
  const groups = new Map();
  for (const e of wf.edges) { const k = `${e.from}>${e.to}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(e.on); }
  const want = [...groups.values()].map((v) => v.join(' / ')).sort();
  ok(JSON.stringify([...labels].sort()) === JSON.stringify(want), `labels differ from the grouping rule: got ${JSON.stringify([...labels].sort())} want ${JSON.stringify(want)}`);
  const total = await page.locator('.react-flow__edge').count();
  ok(total === wf.edges.length, `edge count ${total} vs ${wf.edges.length}`);
  const fix = wf.edges.filter((e) => e.fixRound).length;
  const n = await page.locator('.react-flow__edge.edge-fix').count();
  ok(n === fix && fix >= 3, `edge-fix count ${n}, fixRound edges ${fix}`);
  const dash = await page.locator('.react-flow__edge.edge-fix path.react-flow__edge-path').first().evaluate((p) => getComputedStyle(p).strokeDasharray);
  ok(dash && dash !== 'none', `fix edge not dashed (${dash})`);
  const plain = await page.locator('.react-flow__edge:not(.edge-fix) path.react-flow__edge-path').first().evaluate((p) => getComputedStyle(p).strokeDasharray);
  ok(!plain || plain === 'none', `a plain edge is dashed (${plain})`);
});
await check('AC2: seed is vertical; fix and decision sit right of every main card (screen geometry)', async () => {
  const g = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.fnode')].map((n) => { const r = n.getBoundingClientRect(); return [n.dataset.node, { l: r.left, r: r.right, t: r.top, b: r.bottom }]; })));
  const main = Object.entries(g).filter(([id]) => !['fix', 'decision'].includes(id)).map(([, v]) => v);
  const maxR = Math.max(...main.map((v) => v.r));
  ok(g.fix.l >= maxR - 1 && g.decision.l >= maxR - 1, `fix.left ${g.fix.l.toFixed(0)} / decision.left ${g.decision.l.toFixed(0)} vs main right ${maxR.toFixed(0)}`);
  const order = ['frame', 'gate1', 'plan', 'split', 'implement', 'join', 'verify', 'review', 'whitehat', 'commit', 'report', 'gate2', 'pr', 'done'];
  for (let i = 1; i < order.length; i++) ok(g[order[i]].t > g[order[i - 1]].t, `${order[i]} is not below ${order[i - 1]}`);
  ok(Math.abs(g.implement.t - g.prep.t) < 2, 'implement and prep are not in one layer');
  ok(Math.abs(g.implement.l - g.prep.l) > 20, 'implement and prep overlap');
});
await check('AC2: Auto-layout reproduces the seed positions (seed and autoLayout are in sync) and keeps the shape', async () => {
  const before = (await get('/api/workflow')).draft.workflow.nodes.map((n) => [n.id, n.position.x, n.position.y]);
  await page.getByRole('button', { name: /layout/i }).first().click();
  await page.waitForTimeout(1200);
  const after = (await get('/api/workflow')).draft.workflow.nodes.map((n) => [n.id, n.position.x, n.position.y]);
  ok(JSON.stringify(before) === JSON.stringify(after), 'Auto-layout moved the seed nodes');
  ok(new Set(after.map((a) => `${a[1]},${a[2]}`)).size === after.length, 'duplicate positions');
});

// ---- AC3
await check('AC3: palette cards show an icon and a one-line description; no search box', async () => {
  const items = page.locator('.palette-item');
  ok(await items.count() === 6, `${await items.count()} palette cards`);
  for (let i = 0; i < 6; i++) {
    const it = items.nth(i);
    ok(await it.locator('.palette-icon').isVisible(), `card ${i} icon not visible`);
    const d = it.locator('.palette-desc');
    ok(await d.isVisible(), `card ${i} description not visible`);
    const h = await d.evaluate((e) => ({ h: e.getBoundingClientRect().height, lh: parseFloat(getComputedStyle(e).lineHeight) || 16 }));
    ok(h.h <= h.lh * 2.5, `card ${i} description wraps to several lines (${h.h}px)`);
  }
  ok(await page.locator('aside.palette input').count() === 0, 'palette has an input');
  await page.screenshot({ path: path.join(SHOTS, 'editor-light.png') });
});
await check('AC3: dragging a card onto the canvas adds a node; pressing one adds too; draft-only node has no stats line', async () => {
  const n0 = (await get('/api/workflow')).draft.workflow.nodes.length;
  await page.locator('.palette-item.type-step').dragTo(page.locator('.react-flow__pane').first(), { targetPosition: { x: 200, y: 400 } });
  ok(await until(async () => (await get('/api/workflow')).draft.workflow.nodes.length === n0 + 1, 6000), 'drag did not add a node');
  await page.locator('.palette-item.type-gate').click();
  ok(await until(async () => (await get('/api/workflow')).draft.workflow.nodes.length === n0 + 2, 6000), 'press did not add a node');
  const added = (await get('/api/workflow')).draft.workflow.nodes.slice(n0).map((n) => n.id);
  await page.waitForTimeout(800);
  for (const id of added) {
    ok(await page.locator(`.fnode[data-node="${id}"]`).count() === 1, `card ${id} not drawn`);
    ok(await page.locator(`.fnode[data-node="${id}"] .fnode-stats`).count() === 0, `draft-only node ${id} shows a stats line`);
  }
  // restore: discard the draft
  await page.getByRole('button', { name: 'Discard' }).click();
  const dlg = page.getByRole('alertdialog');
  await dlg.waitFor({ timeout: 3000 });
  await dlg.getByRole('button', { name: /^confirm$/i }).click();
  ok(await until(async () => (await get('/api/workflow')).draft.workflow.nodes.length === n0, 6000), 'discard failed');
  await page.waitForTimeout(600);
});

// ---- drive the fixture runs (RA finishes, with node tokens from a lead subagent; RC decision; RD running; RE stopped)
const RA = await start('Passed run');
await hook(app.port, { hook_event_name: 'PostToolUse', session_id: SESSION, transcript_path: rp(SESSION), cwd: '/x', tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: 'x' },
  tool_response: { content: [{ type: 'text', text: `RUN ${RA} · stage frame (Frame) · round 0/5 · status active` }] } });
await hook(app.port, { hook_event_name: 'PreToolUse', session_id: SESSION, transcript_path: rp(SESSION), cwd: '/x', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 't0' });
await hook(app.port, { hook_event_name: 'PreToolUse', session_id: SESSION, agent_id: 'lead1', agent_type: 'lead', transcript_path: rp(SESSION), cwd: '/x', tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 't1' });
await done(RA, 'frame'); await answer(RA, 'Agree spec');
fs.mkdirSync(path.dirname(sub('lead1')), { recursive: true });
fs.writeFileSync(sub('lead1'), tline('m1', 'lead1', Date.now(), 3000, 1000) + '\n'); // while plan is active
await done(RA, 'plan');
await until(async () => (await get(`/api/runs/${RA}`)).nodes?.plan?.tokens?.total > 0, 15000, 200);
await done(RA, 'implement'); await done(RA, 'prep');
await done(RA, 'verify', 'fail');
await done(RA, 'fix');
fs.appendFileSync(sub('lead1'), tline('m2', 'lead1', Date.now(), 7000, 2345) + '\n'); // while verify (2nd visit) is active
await until(async () => (await get(`/api/runs/${RA}`)).nodes?.verify?.tokens?.total > 0, 15000, 200);
await done(RA, 'verify', 'pass');
for (const s of ['review', 'whitehat']) await done(RA, s, 'pass');
for (const s of ['commit', 'report']) await done(RA, s);
await answer(RA, 'Accept');
await done(RA, 'pr');
ok((await get(`/api/runs/${RA}`)).run.status === 'done', 'RA is not done');

const RC = await start('Decision run');
await toVerify(RC); await done(RC, 'verify', 'regression');
const RD = await start('Running run');
await toVerify(RD); await done(RD, 'verify', 'fail'); await done(RD, 'fix');
const RE = await start('Stopped run');
await done(RE, 'frame');
await app.api('POST', `/api/runs/${RE}/stop`, { body: {} });

const runState = async (id) => {
  await page.goto(`${base}/#/runs/${id}`);
  await page.getByRole('group', { name: 'Run graph' }).waitFor({ timeout: 8000 });
  await page.locator('.fnode[data-node="frame"]').waitFor({ timeout: 8000 });
  await page.waitForTimeout(700);
  return page.evaluate(() => Object.fromEntries([...document.querySelectorAll('.fnode')].map((n) => [n.dataset.node, { state: n.dataset.state, status: n.querySelector('.fnode-status')?.textContent.trim() ?? null, fails: n.querySelector('.badge.fails')?.textContent.trim() ?? null, cls: n.className }])));
};

// ---- AC4 with real numbers
await check('AC4 editor: each node line equals the /api/stats/versions per-node numbers via the shared formatters', async () => {
  await page.goto(`${base}/#/workflow`);
  await waitCards();
  const v = (await get('/api/workflow')).published.version;
  const sv = (await get('/api/stats/versions')).find((x) => x.version === v);
  ok(sv.finishedRuns === 1, `finishedRuns ${sv.finishedRuns}`);
  const anyTokens = sv.nodes.some((n) => n.avgTokens > 0);
  if (!anyTokens) notes.push('ENV: no node got tokens in the fixture (indexer attribution), AC4 compared zero token figures only');
  let withTokens = 0;
  for (const n of sv.nodes.filter((x) => !['split', 'join'].includes(x.id))) {
    const loc = page.locator(`.fnode[data-node="${n.id}"] .fnode-stats`);
    ok(await until(async () => (await loc.count()) === 1, 5000), `no stats line on ${n.id}`);
    const want = n.runs === 0 ? /never reached/i : null;
    const text = (await until(async () => { const t = await loc.innerText(); return /no runs yet/i.test(t) ? null : t; }, 8000)) ?? await loc.innerText();
    if (n.runs === 0) ok(want.test(text), `${n.id}: expected "never reached", got "${text}"`);
    else {
      ok(text.includes(`${formatTokens(n.avgTokens)} tokens`), `${n.id}: "${text}" lacks ${formatTokens(n.avgTokens)} tokens`);
      ok(text.includes(formatDuration(n.avgDurationMs)), `${n.id}: "${text}" lacks ${formatDuration(n.avgDurationMs)}`);
      if (n.avgTokens > 0) withTokens++;
    }
  }
  if (anyTokens) ok(withTokens >= 1, 'no node showed a non-zero token figure');
  const published = (await get('/api/workflow')).published.workflow.nodes.map((n) => n.id);
  ok(sv.nodes.length === published.length, 'stats nodes != published nodes');
});

// ---- AC5 run states
await check('AC5 run view: finished run RA is mostly green; verify is passed with "1 fail"; end node done passed, stopped idle', async () => {
  const s = await runState(RA);
  ok(s.verify.state === 'passed' && /^✓/.test(s.verify.status), `verify ${JSON.stringify(s.verify)}`);
  ok(s.verify.fails === '1 fail', `verify fails badge "${s.verify.fails}"`);
  ok(s.gate1.state === 'passed' && s.gate1.status === '✓ Agree spec', `gate1 ${JSON.stringify(s.gate1)}`);
  ok(s.gate2.status === '✓ Accept', `gate2 ${JSON.stringify(s.gate2)}`);
  ok(s.done.state === 'passed', `done ${JSON.stringify(s.done)}`);
  ok(s.stopped.state === 'idle', `stopped ${JSON.stringify(s.stopped)}`);
  ok(s.decision.state === 'idle' && s.decision.status === null, `decision ${JSON.stringify(s.decision)}`);
  ok(s.split.state === 'passed' && s.join.state === 'passed', 'split/join not passed');
  ok(s.fix.state === 'passed', `fix ${JSON.stringify(s.fix)}`);
  ok(Object.values(s).every((x) => !/\b(visited|active)\b/.test(x.cls)), 'old visited/active class still present');
  ok(await page.locator('.badge.here').count() === 0, 'old "active" badge still present');
  ok(await page.locator('.fnode-stats').count() === 0, 'stats line shown in run view');
  await page.screenshot({ path: path.join(SHOTS, 'run-passed-light.png') });
});
await check('AC5 run view: waiting run RB is amber at gate1 with text; frame is green', async () => {
  const s = await runState(RB);
  ok(s.gate1.state === 'waiting' && s.gate1.status === '⏸ waiting on Ryan', `gate1 ${JSON.stringify(s.gate1)}`);
  ok(s.frame.state === 'passed', `frame ${JSON.stringify(s.frame)}`);
  ok(s.plan.state === 'idle', `plan ${JSON.stringify(s.plan)}`);
});
await check('AC5 run view: decision run RC is red "decision needed"; verify failed with regression text', async () => {
  const s = await runState(RC);
  ok(s.decision.state === 'decision' && s.decision.status === '✕ decision needed', `decision ${JSON.stringify(s.decision)}`);
  ok(s.verify.state === 'failed' && s.verify.status === '✕ regression', `verify ${JSON.stringify(s.verify)}`);
  ok(s.implement.state === 'passed' || s.implement.state === 'halted', `implement ${JSON.stringify(s.implement)}`);
});
await check('AC5 run view: running run RD shows verify running with "1 fail"; fix passed', async () => {
  const s = await runState(RD);
  ok(s.verify.state === 'running' && s.verify.status === '▶ running', `verify ${JSON.stringify(s.verify)}`);
  ok(s.verify.fails === '1 fail', `fails "${s.verify.fails}"`);
  ok(s.fix.state === 'passed', `fix ${JSON.stringify(s.fix)}`);
  ok(s.pr.state === 'idle', `pr ${JSON.stringify(s.pr)}`);
});
await check('AC5 run view: stopped run RE is halted, not red or green', async () => {
  const s = await runState(RE);
  ok(s.gate1.state === 'halted' && /^– stopped/.test(s.gate1.status), `gate1 ${JSON.stringify(s.gate1)}`);
  ok(s.frame.state === 'passed', `frame ${JSON.stringify(s.frame)}`);
});
await check('AC5: legend explains every colour with an icon or text, and the run view is at >= 12 px names', async () => {
  await runState(RD);
  const lg = page.locator('.run-legend');
  ok(await lg.count() === 1 && await lg.getAttribute('aria-label') === 'Colour legend', 'no legend');
  ok(await lg.isVisible(), 'legend hidden');
  ok(await lg.getAttribute('role') === 'group', 'legend is not role=group');
  ok(await page.getByRole('group', { name: 'Run graph' }).locator('.run-legend').count() === 0, 'legend is still inside the Run graph group');
  const txt = await lg.innerText();
  for (const w of [/passed/i, /failed|decision/i, /waiting on ryan/i, /running/i, /not reached|stopped/i, /✓/, /✕/, /⏸/, /▶/]) ok(w.test(txt), `legend lacks ${w}: ${txt}`);
  const r = await effectiveNameSizes();
  ok(Math.min(...r.sizes) >= 11.95, `run view names ${Math.min(...r.sizes).toFixed(2)} px effective (zoom ${r.scale.toFixed(2)})`);
});
await check('AC5: the five colours are visibly different (hue family per state, colour is not the only signal)', async () => {
  await runState(RD);
  const rgbs = async (id) => page.evaluate((nid) => {
    const n = document.querySelector(`.fnode[data-node="${nid}"]`);
    const cs = [getComputedStyle(n).borderTopColor, getComputedStyle(n).borderLeftColor, getComputedStyle(n).backgroundColor, getComputedStyle(n).outlineColor];
    return cs;
  }, id);
  const hue = (c) => {
    const m = c.match(/[\d.]+/g).map(Number); if (m.length > 3 && m[3] === 0) return null;
    const k = c.startsWith('color(') ? 1 : 255; const [r, g, b] = m.slice(0, 3).map((v) => v / k); const mx = Math.max(r, g, b), mn = Math.min(r, g, b); const d = mx - mn;
    if (d < 0.12) return null;
    let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; h *= 60; return h < 0 ? h + 360 : h;
  };
  const fam = { passed: [80, 175], failed: [340, 20], running: [190, 265], waiting: [25, 65] };
  const ids = { passed: 'plan', failed: null, running: 'verify', waiting: null };
  const sig = {};
  for (const [state, id] of Object.entries(ids)) {
    if (!id) continue;
    const cols = await rgbs(id);
    const hs = cols.map(hue).filter((h) => h != null);
    const [lo, hi] = fam[state];
    const hit = hs.some((h) => (lo <= hi ? h >= lo && h <= hi : h >= lo || h <= hi));
    ok(hit, `${state} (${id}) colours ${cols.join(' / ')} have no hue in ${lo}-${hi}`);
    sig[state] = cols.join('|');
  }
  const s = await runState(RC);
  ok(s.decision.state === 'decision', 'decision state missing');
  const failedCols = await rgbs('verify'); const decCols = await rgbs('decision');
  for (const [name, cols] of [['failed', failedCols], ['decision', decCols]]) ok(cols.map(hue).filter((h) => h != null).some((h) => h >= 340 || h <= 20), `${name} has no red`);
  await runState(RB);
  const wc = await rgbs('gate1');
  ok(wc.map(hue).filter((h) => h != null).some((h) => h >= 25 && h <= 65), `waiting ${wc.join(' / ')} has no amber`);
  const idle = await rgbs('plan');
  ok(idle.join('|') !== sig.passed && idle.join('|') !== sig.running, 'idle looks like passed/running');
});

// ---- AC6 contrast, light and dark, editor and run view
const probe = () => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/[\d.]+/g).map(Number); const k = c.startsWith('color(') ? 255 : 1; return { r: m[0] * k, g: m[1] * k, b: m[2] * k, a: m.length > 3 ? m[3] : 1 }; };
  const lin = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const over = (top, bot) => ({ r: top.r * top.a + bot.r * (1 - top.a), g: top.g * top.a + bot.g * (1 - top.a), b: top.b * top.a + bot.b * (1 - top.a), a: 1 });
  const bgOf = (el) => {
    const chain = []; for (let e = el; e; e = e.parentElement) chain.push(parse(getComputedStyle(e).backgroundColor));
    let acc = { r: 255, g: 255, b: 255, a: 1 }; // fallback canvas; body defines its own
    for (const c of chain.reverse()) if (c.a > 0) acc = over(c, acc);
    return acc;
  };
  const bad = []; const seen = new Set();
  const sels = ['.fnode-name', '.fnode-type', '.fnode-sub', '.fnode-status', '.fnode-stats', '.fnode .badge', '.palette-desc', '.palette-item', '.run-legend', '.run-legend *', '.react-flow__edge-text', '.topbar'];
  for (const sel of sels) for (const el of document.querySelectorAll(sel)) {
    if (!el.textContent.trim() || el.children.length > 3) continue;
    const key = sel + getComputedStyle(el).color + el.closest('.fnode')?.dataset.state;
    if (seen.has(key)) continue; seen.add(key);
    const fg = parse(getComputedStyle(el).color); const bg = bgOf(el);
    const fgc = over(fg, bg); const a = lum(fgc), b = lum(bg);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (ratio < 3) bad.push(`${sel}[${el.closest('.fnode')?.dataset.state ?? ''}] ${ratio.toFixed(2)}`);
  }
  return bad;
});
for (const scheme of ['light', 'dark']) {
  await check(`AC6 ${scheme}: run-state cards, legend, palette and edge text keep >= 3:1 contrast`, async () => {
    if (scheme === 'dark') { await cur.ctx.close(); cur = await newPage('dark'); page = cur.p; }
    const failures = [];
    for (const id of [RA, RB, RC, RD, RE]) { await runState(id); if (scheme === 'dark' && id === RD) await page.screenshot({ path: path.join(SHOTS, 'run-dark.png') }); failures.push(...(await probe()).map((f) => `run:${f}`)); }
    await page.goto(`${base}/#/workflow`); await waitCards();
    if (scheme === 'dark') await page.screenshot({ path: path.join(SHOTS, 'editor-dark.png') });
    failures.push(...(await probe()).map((f) => `editor:${f}`));
    ok(failures.length === 0, `low contrast (${scheme}): ${[...new Set(failures)].join(' ; ')}`);
  });
}
await check('AC6 dark: card, page and legend backgrounds are actually dark (theme tokens defined for dark)', async () => {
  await runState(RD);
  const bgs = await page.evaluate(() => ['body', '.fnode', '.run-legend'].map((s) => { const e = document.querySelector(s); return e ? getComputedStyle(e).backgroundColor : null; }));
  const lumOf = (c) => { const m = c.match(/[\d.]+/g).map(Number); const k = c.startsWith('color(') ? 255 : 1; return k * (m[0] + m[1] + m[2]) / 3; };
  ok(lumOf(bgs[0]) < 90, `body background ${bgs[0]}`);
  ok(lumOf(bgs[1]) < 110 || /(, 0\)|\/ 0\))/.test(bgs[1]), `card background ${bgs[1]}`);
  ok(bgs[2] === null || lumOf(bgs[2]) < 130 || /(, 0\)|\/ 0\))/.test(bgs[2]), `legend background ${bgs[2]}`);
});

await check('no window dialogs and no uncaught page errors', async () => ok(dialogs.length === 0 && pageErrors.length === 0, `${dialogs.join(';')} ${pageErrors.join(';')}`));

await browser.close();
await app.srv.close();
console.log('\nRESULTS');
for (const [n, s, m] of results) console.log(`${s.padEnd(5)} ${n}${m ? `  -> ${m}` : ''}`);
for (const n of notes) console.log(`NOTE ${n}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
