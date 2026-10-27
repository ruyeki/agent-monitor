// UI e2e for Agent Monitor v2: monitor, run view (pinned graph, live) and the canvas workflow editor.
// Run:  npm --prefix web run build -- --outDir <tmp>/dist --emptyOutDir && WEB_DIR=<tmp>/dist npm run e2e
// Boots its own server on a free port with a temp home. Never touches ~/.claude. Screenshots go to a temp dir.
// Written to the graph REST contract (nodes/edges, errors [{message,node?,edge?}], run.active, run detail visits/nodes).
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
ok(fs.existsSync(path.join(webDir, 'index.html')), 'web build not found (set WEB_DIR to a temp build)');
const app = await boot({ webDir });
const base = app.url.replace(/\/$/, '');
const get = async (p) => (await app.api('GET', p)).json;
const draft = async () => (await get('/api/workflow')).draft.workflow;
const versions = async () => get('/api/workflow/versions');
const ids = (wf) => wf.nodes.map((n) => n.id);
const savedText = async () => (await page.locator('[role=status]').allInnerTexts()).join(' | ');
const waitSaved = () => until(async () => /Draft — saved/.test(await savedText()), 5000, 100);
const node = (id) => page.locator(`.react-flow__node[data-id="${id}"]`);
const fnode = (id) => page.locator(`.fnode[data-node="${id}"]`);

// ---- seed runs through MCP (the same path agents use)
const mcp = await mcpClient(app.url);
const start = async (title) => runIdOf((await mcp.call('start_run', { title })).text);
const waiting = await start('Waiting for Ryan');
await mcp.call('complete_stage', { run: waiting, stage: 'frame', outcome: 'pass' });
const viewed = await start('Viewed run');
await mcp.call('complete_stage', { run: viewed, stage: 'frame', outcome: 'pass' });
const toStop = await start('Run to stop');

const browser = await chromium.launch({ executablePath: CHROME, headless: true });
const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'light' });
page = await ctx.newPage();
page.on('dialog', async (d) => { dialogs.push(`${d.type()}: ${d.message()}`); await d.dismiss(); });
const pageErrors = [];
page.on('pageerror', (e) => pageErrors.push(String(e)));
await page.goto(`${base}/#/`);

// ---- Monitor
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

await check('monitor: a run row opens #/runs/<id>; Stop confirm flow ends the run', async () => {
  await page.getByRole('row', { name: /Run to stop/ }).first().click();
  await page.waitForURL(new RegExp(`#/runs/${toStop}$`));
  await page.getByRole('region', { name: `Run ${toStop}` }).waitFor({ timeout: 5000 });
  await page.getByRole('button', { name: /^stop$/i }).click();
  await page.getByRole('group', { name: /confirm stop/i }).waitFor({ timeout: 3000 });
  await page.getByRole('button', { name: /^confirm$/i }).click();
  ok(await until(async () => (await get(`/api/runs/${toStop}`)).run.status === 'stopped', 5000), 'run is not stopped after confirm');
});

// ---- Run view
await check('run view: pinned graph with the active node, visited marks and visit counts', async () => {
  await page.goto(`${base}/#/runs/${viewed}`);
  await page.getByRole('group', { name: 'Run graph' }).waitFor({ timeout: 8000 });
  await fnode('gate1').waitFor({ timeout: 5000 });
  ok((await fnode('gate1').getAttribute('class')).includes('active'), 'gate1 is not highlighted as active');
  ok((await fnode('frame').getAttribute('class')).includes('visited'), 'frame is not marked visited');
  ok(/1 visit/.test(await fnode('frame').innerText()), 'frame shows no visit count');
  ok(!(await fnode('plan').getAttribute('class')).includes('visited'), 'plan is marked visited before it ran');
  await page.screenshot({ path: path.join(SHOTS, '01-run-view.png') });
});

await check('run view: read-only graph (no dragging, no connecting)', async () => {
  const cls = await node('frame').getAttribute('class');
  ok(!/draggable/.test(cls), 'node is draggable');
  ok(await page.locator('.run-graph .react-flow__handle.connectable').count() === 0, 'handles are connectable');
});

await check('run view: side panel shows the ask, totals and timeline; responding moves the highlight live', async () => {
  const side = page.getByRole('complementary', { name: 'Run details' });
  ok(/solution/i.test(await side.innerText()), 'ask is not shown');
  ok(/Tokens:/.test(await side.getByRole('region', { name: 'Totals' }).innerText()), 'no token total');
  ok(/Duration:/.test(await side.getByRole('region', { name: 'Totals' }).innerText()), 'no duration');
  ok(await side.getByRole('region', { name: 'Timeline' }).getByRole('listitem').count() > 0, 'empty timeline');
  await side.getByRole('button', { name: /agree spec/i }).click();
  ok(await until(async () => (await get(`/api/runs/${viewed}`)).run.stage === 'plan', 5000), 'run did not move to plan');
  ok(await until(async () => (await fnode('plan').getAttribute('class')).includes('active'), 6000), 'plan was not highlighted live');
  ok(await until(async () => (await fnode('gate1').getAttribute('class')).includes('visited'), 3000), 'gate1 was not marked visited');
});

// ---- Stats
await check('stats: nav has Stats; the page shows period cards, the chart, versions and prices', async () => {
  await page.goto(`${base}/#/`);
  const nav = page.getByRole('navigation', { name: 'Sections' });
  ok((await nav.getByRole('link').allInnerTexts()).join() === 'Monitor,Workflow,Stats', 'nav is not Monitor,Workflow,Stats');
  await nav.getByRole('link', { name: 'Stats' }).click();
  await page.waitForURL(/#\/stats$/);
  await page.getByRole('region', { name: 'Usage statistics' }).waitFor({ timeout: 8000 });
  const cards = page.getByRole('article');
  await cards.first().waitFor({ timeout: 8000 });
  ok(await cards.count() === 4, 'expected four period cards');
  ok(/API-equivalent \(estimate\)/.test(await cards.first().innerText()), 'no estimate label on the card');
  await page.getByRole('button', { name: '30 days' }).click();
  ok(await page.getByRole('button', { name: '30 days' }).getAttribute('aria-pressed') === 'true', '30 days toggle not pressed');
  await page.getByRole('img', { name: /Stacked bars of daily tokens/ }).waitFor({ timeout: 3000 });
  await page.getByRole('region', { name: 'Workflow versions' }).waitFor({ timeout: 3000 });
  await page.getByRole('region', { name: 'Prices' }).waitFor({ timeout: 3000 });
  ok(/claude-api skill, 2026-10-06; estimates only/.test(await page.getByRole('region', { name: 'Prices' }).innerText()), 'no price source note');
  await page.screenshot({ path: path.join(SHOTS, '06-stats.png') });
});

await check('stats: no horizontal page scroll at 390 px wide', async () => {
  await page.setViewportSize({ width: 390, height: 800 });
  try {
    for (const hash of ['#/stats', '#/']) {
      await page.goto(`${base}/${hash}`);
      await page.getByRole('heading', { level: 1 }).waitFor({ timeout: 3000 });
      await page.waitForTimeout(500);
      const w = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth, document.querySelector('main').scrollWidth, document.querySelector('main').clientWidth]);
      ok(w[0] <= w[1] && w[2] <= w[3], `${hash} scrolls sideways: ${w.join(' / ')}`);
    }
  } finally { await page.setViewportSize({ width: 1500, height: 950 }); }
});

// ---- Editor
const connectNodes = async (from, to) => {
  const a = await node(from).locator('.react-flow__handle.source').boundingBox();
  const b = await node(to).locator('.react-flow__handle.target').boundingBox();
  ok(a && b, 'handles not found');
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 - 30, b.y + b.height / 2, { steps: 8 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 4 });
  await page.mouse.up();
};

await check('editor: opens full page with palette, canvas, settings and top bar', async () => {
  await page.goto(`${base}/#/workflow`);
  await page.getByRole('button', { name: /^publish$/i }).waitFor({ timeout: 8000 });
  await node('frame').waitFor({ timeout: 5000 });
  const names = await page.getByRole('complementary', { name: 'Node palette' }).getByRole('button').allInnerTexts();
  ok(names.join() === 'Step,Check,Gate,Split,Join,End', `palette: ${names.join()}`);
  ok(/Published v\d+/.test(await page.locator('.topbar').innerText()), 'no Published vN');
  ok(/Draft — saved/.test(await savedText()), 'draft is not shown as saved');
  await page.getByRole('region', { name: 'Loop settings' }).waitFor({ timeout: 2000 });
  ok(await page.getByLabel('Max rounds (1-10)').inputValue() === '5', 'max rounds is not 5');
  await page.screenshot({ path: path.join(SHOTS, '02-editor-light.png') });
});

await check('editor: dragging Step from the palette onto the canvas adds a node at the drop point', async () => {
  const n0 = ids(await draft()).length;
  const pane = page.locator('.react-flow__pane');
  const box = await pane.boundingBox();
  await page.getByRole('button', { name: 'Step', exact: true }).dragTo(pane, { targetPosition: { x: box.width - 150, y: box.height - 90 } });
  const added = await until(async () => { const d = await draft(); return ids(d).length === n0 + 1 ? d : null; }, 5000);
  ok(added, 'draft did not gain a node');
  const n = added.nodes.at(-1);
  ok(n.type === 'step' && n.position && (n.position.x !== 0 || n.position.y !== 0), `new node: ${JSON.stringify(n)}`);
  ok(await waitSaved(), 'not saved after the drop');
  ok(await page.getByLabel('Id').inputValue() === n.id, 'the new node is not selected in the panel');
});

let connEdge;
await check('editor: settings panel edits the node and renames its id', async () => {
  await page.getByLabel('Name', { exact: true }).fill('Extra step');
  await page.getByLabel('Runner').selectOption('verifier');
  await page.getByLabel('Model').selectOption('sonnet');
  await page.getByLabel('Instructions').fill('Do the extra thing.');
  const id = page.getByLabel('Id');
  await id.fill('extra');
  await id.press('Enter');
  const d = await until(async () => { const x = await draft(); return ids(x).includes('extra') ? x : null; }, 5000);
  ok(d, 'rename was not saved');
  const n = d.nodes.find((x) => x.id === 'extra');
  ok(n.name === 'Extra step' && n.runner === 'verifier' && n.model === 'sonnet' && n.instructions === 'Do the extra thing.', `node: ${JSON.stringify(n)}`);
});

await check('editor: connecting handle to handle creates an edge; clicking an edge selects it and edits on', async () => {
  const e0 = (await draft()).edges.length;
  await connectNodes('extra', 'commit');
  const d = await until(async () => { const x = await draft(); return x.edges.length === e0 + 1 ? x : null; }, 5000);
  ok(d, 'no edge was created by the connection');
  const e = d.edges.at(-1);
  connEdge = e.id;
  ok(e.from === 'extra' && e.to === 'commit' && e.on === 'done', `edge: ${JSON.stringify(e)}`);
  const sel = page.locator('label.field').filter({ has: page.locator('span', { hasText: /^On$/ }) }).locator('select');
  await sel.waitFor({ timeout: 3000 });
  await sel.selectOption('pass');
  ok(await until(async () => (await draft()).edges.find((x) => x.id === e.id)?.on === 'pass', 5000), 'on was not saved');
  // click an existing edge: the panel shows its on, with the valid choices for its source
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.locator('.react-flow__edge[data-id="verify>review:pass"]').dispatchEvent('click');
  ok(await page.locator('label.field').filter({ has: page.locator('span', { hasText: /^On$/ }) }).locator('select').inputValue() === 'pass', 'clicking the edge did not select it');
  const fix = page.locator('.react-flow__edge[data-id="verify>fix:fail"]');
  await fix.dispatchEvent('click');
  ok(await page.getByLabel('Fix round').isChecked(), 'verify>fix is not a fix-round edge');
});

await check('editor: Delete key removes the selected edge, then the selected node', async () => {
  await page.locator(`.react-flow__edge[data-id="${connEdge}"]`).dispatchEvent('click');
  await page.keyboard.press('Delete');
  ok(await until(async () => !(await draft()).edges.some((e) => e.from === 'extra'), 5000), 'edge not deleted by the key');
  await node('extra').click();
  await page.keyboard.press('Backspace');
  ok(await until(async () => !ids(await draft()).includes('extra'), 5000), 'node not deleted by the key');
});

await check('editor: dragging a node saves its position', async () => {
  const before = (await draft()).nodes.find((n) => n.id === 'commit').position;
  const b = await node('commit').boundingBox();
  await page.mouse.move(b.x + b.width / 2, b.y + 10);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2 + 20, b.y + 60, { steps: 6 });
  await page.mouse.move(b.x + b.width / 2 + 40, b.y + 110, { steps: 6 });
  await page.mouse.up();
  const moved = await until(async () => { const p = (await draft()).nodes.find((n) => n.id === 'commit').position; return p.x !== before.x || p.y !== before.y ? p : null; }, 5000);
  ok(moved, 'position was not saved');
  ok(await waitSaved(), 'not saved after the drag');
});

await check('editor: gate actions can be added, renamed and removed with their edges kept in sync', async () => {
  await node('gate2').click();
  const before = (await draft()).edges.filter((e) => e.from === 'gate2').map((e) => e.on);
  const label = page.getByLabel('Action 1 label');
  const old = await label.inputValue();
  await label.fill('Approve');
  ok(await until(async () => (await draft()).edges.some((e) => e.from === 'gate2' && e.on === 'Approve'), 5000), 'edge on was not renamed with the action');
  ok(!before.includes('Approve'), 'fixture error');
  await page.getByRole('button', { name: 'Add action' }).click();
  ok(await until(async () => (await draft()).nodes.find((n) => n.id === 'gate2').actions.length === before.length + 1, 5000), 'action not added');
  await page.getByRole('button', { name: `Remove action ${before.length + 1}` }).click();
  ok(await until(async () => (await draft()).nodes.find((n) => n.id === 'gate2').actions.length === before.length, 5000), 'action not removed');
  await label.fill(old);
  ok(await waitSaved(), 'not saved');
});

await check('editor: loop settings change maxRounds', async () => {
  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await page.getByLabel('Max rounds (1-10)').fill('7');
  ok(await until(async () => (await draft()).loop.maxRounds === 7, 5000), 'maxRounds not saved');
  await page.getByLabel('Max rounds (1-10)').fill('5');
  ok(await waitSaved(), 'not saved');
});

await check('editor: Publish of an invalid draft lists the errors, highlights the node and creates no version', async () => {
  const v0 = (await versions()).length;
  await page.getByRole('button', { name: 'Check', exact: true }).click(); // a check with no edges at all
  ok(await until(async () => ids(await draft()).includes('check-2'), 5000), 'check was not added');
  ok(await waitSaved(), 'not saved');
  await page.getByRole('button', { name: /^publish$/i }).click();
  const list = page.getByRole('alert', { name: 'Publish errors' });
  await list.waitFor({ timeout: 5000 });
  ok(await list.getByRole('listitem').count() > 0, 'no errors listed');
  ok(await page.locator('.fnode.has-error').count() > 0, 'no node is highlighted');
  const target = list.getByRole('button', { name: /check-2/ }).first();
  await target.click();
  ok(await page.getByLabel('Id').inputValue() === 'check-2', 'clicking the error did not select its node');
  ok((await versions()).length === v0, 'a version was created from an invalid draft');
  await page.screenshot({ path: path.join(SHOTS, '03-publish-errors.png') });
  await page.getByRole('button', { name: 'Delete node' }).click();
  ok(await until(async () => !ids(await draft()).includes('check-2'), 5000), 'node not deleted by the button');
  await waitSaved();
});

await check('editor: Auto-layout saves distinct positions in layers', async () => {
  await page.getByRole('button', { name: 'Auto-layout' }).click();
  const d = await until(async () => { const x = await draft(); return new Set(x.nodes.map((n) => `${n.position.x},${n.position.y}`)).size === x.nodes.length ? x : null; }, 5000);
  ok(d, 'positions are not distinct');
  const x = (id) => d.nodes.find((n) => n.id === id).position.x;
  ok(x('frame') === 0 && x('gate1') === 220, `frame ${x('frame')}, gate1 ${x('gate1')}`);
  ok(await waitSaved(), 'not saved');
});

await check('editor: Publish a valid draft creates the next version; in-flight run stays on its version', async () => {
  const v0 = await versions();
  const pinned = (await get(`/api/runs/${toStop}`)).run.workflowVersion;
  await page.getByRole('button', { name: /^publish$/i }).click();
  ok(await until(async () => (await versions()).length === v0.length + 1, 6000), 'no new version');
  const top = Math.max(...(await versions()).map((v) => v.version));
  ok(await until(async () => new RegExp(`Published v${top}`).test(await page.locator('.topbar').innerText()), 5000), 'page does not show the new version');
  ok((await get(`/api/runs/${toStop}`)).run.workflowVersion === pinned, 'a pinned run changed version');
  ok(await page.getByRole('alert', { name: 'Publish errors' }).count() === 0, 'errors still shown after a good publish');
});

await check('editor: Versions loads an old version into the draft; Discard restores the published one', async () => {
  const vs = await versions();
  ok(vs.length >= 2, 'need two versions');
  const first = Math.min(...vs.map((v) => v.version));
  await page.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('button', { name: `Load v${first} into draft` }).click();
  const dlg = page.getByRole('alertdialog');
  if (await dlg.count()) await dlg.getByRole('button', { name: /^confirm$/i }).click();
  const old = (await get(`/api/workflow/versions/${first}`)).workflow;
  ok(await until(async () => JSON.stringify(ids(await draft())) === JSON.stringify(ids(old)), 5000), 'draft does not have the old version nodes');
  await page.getByRole('button', { name: 'Discard' }).click();
  const confirm = page.getByRole('alertdialog');
  await confirm.waitFor({ timeout: 3000 });
  await confirm.getByRole('button', { name: /^confirm$/i }).click();
  const pub = (await get('/api/workflow')).published.workflow;
  ok(await until(async () => JSON.stringify(await draft()) === JSON.stringify(pub), 5000), 'draft is not the published workflow after Discard');
});

await check('no window dialogs fired', async () => ok(dialogs.length === 0, dialogs.join(' ; ')));
await check('no uncaught page errors', async () => ok(pageErrors.length === 0, pageErrors.join(' ; ')));

// ---- dark theme screenshots + crude readability check
await check('dark theme renders with readable text', async () => {
  await ctx.close();
  const dctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, colorScheme: 'dark' });
  page = await dctx.newPage();
  await page.goto(`${base}/#/workflow`);
  await page.getByRole('button', { name: /^publish$/i }).waitFor({ timeout: 8000 });
  await node('frame').click();
  await page.screenshot({ path: path.join(SHOTS, '04-editor-dark.png') });
  const probe = await page.evaluate(() => {
    const lum = (c) => { const m = c.match(/[\d.]+/g).map(Number); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(m[0]) + 0.7152 * f(m[1]) + 0.0722 * f(m[2]); };
    const bad = [];
    for (const sel of ['body', '.topbar', '.fnode', '.settings label', '.palette-item', '.react-flow__edge-text']) {
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
  ok(probe.length === 0, `low contrast: ${probe.join(' ; ')}`);
  await page.goto(`${base}/#/runs/${viewed}`);
  await page.getByRole('group', { name: 'Run graph' }).waitFor({ timeout: 8000 });
  await page.screenshot({ path: path.join(SHOTS, '05-run-dark.png') });
});

await browser.close();
await app.srv.close();
console.log('\nRESULTS');
for (const [n, s, m] of results) console.log(`${s.padEnd(5)} ${n}${m ? `  -> ${m}` : ''}`);
console.log(`screenshots: ${SHOTS}`);
process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
