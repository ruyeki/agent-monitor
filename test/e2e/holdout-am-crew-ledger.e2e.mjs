// Holdout e2e (#2339): Crew tab layout (no horizontal scroll, connectors, themes), card click -> agent activity, Ledger tab.
// Seeds through the store directly so it does not depend on the hooks change. Needs WEB_DIR (built bundle) and CHROME_PATH.
import { kit, runIdOf, until, fs, path } from './holdout-am-affect-pro-kit.mjs';

const k = await kit('am-crew-ledger');
const { srv, base, call, get, ok, check, newPage, finish } = k;
const store = srv.store;
const SHOTS = process.env.AM_PRO_SHOTS;

const id = runIdOf(await call('start_run', { title: 'Crew layout e2e' }));
const sid = 's-lay';
store.linkSession(sid, id);
const mk = (aid, type, parent, over = {}) => {
  store.createAgent({ id: aid, runId: id, sessionId: sid, type });
  store.updateAgent(aid, { parent_agent_id: parent, description: over.description ?? `Task of ${aid}`, model: over.model ?? 'claude-sonnet-5-5', tool_calls: over.calls ?? 3, status: over.status ?? 'running' });
};
mk(`main:${sid}`, 'main', null, { model: 'claude-opus-5-5', description: 'Main session', status: 'idle' });
mk('lead', 'fable-lead', `main:${sid}`, { model: 'claude-opus-5-5', description: 'Lead: a rather long task description that wraps over several lines to stress the card width' });
for (let i = 0; i < 10; i++) mk(`h${i}`, i % 2 ? 'sonnet-engineer' : 'opus-engineer', 'lead', { description: `Helper number ${i} with a fairly long description to wrap` });
mk('n1', 'haiku-engineer', 'h0', { description: 'Nested one' });
mk('n2', 'haiku-engineer', 'h0', { description: 'Nested two' });
mk('nn', 'verifier', 'n1', { description: 'Nested depth four' });
mk('stray', 'white-hat', null, { description: 'No recorded parent' });

// 150 tool rows for h2 first, then 120 rows from other agents, so h2's calls fall outside the last 100 rows.
for (let i = 0; i < 150; i++) store.addActivity(id, 'h2', 'tool', 'Read', `oldcall-${i}.txt`, `h2-${i}`);
for (let i = 0; i < 120; i++) store.addActivity(id, i % 2 ? 'h3' : 'h4', 'tool', 'Grep', `other-${i}`, `o-${i}`);
for (let i = 0; i < 150; i++) store.endActivity(id, `h2-${i}`, 'ok');
store.addChange(id, 'h2', 'Bash', 'chg1', 'git push origin feat/crew-ledger');
store.endChange(id, 'chg1', 'ok', 'abc1234..def5678  feat/crew-ledger -> feat/crew-ledger');
store.addChange(id, 'h5', 'Bash', 'chg2', 'git commit -m "Seeded change"');
store.endChange(id, 'chg2', 'ok', '[feat 9a8b7c6] Seeded change');

const SIZES = [[1280, 800], [1440, 900], [390, 844]];
const hOverflow = (p) => p.evaluate(() => {
  const de = document.documentElement;
  const panel = document.querySelector('#panel-crew');
  const crew = document.querySelector('section[aria-label="Crew"]');
  const scrollers = [...document.querySelectorAll('#panel-crew *')].filter((e) => { const s = getComputedStyle(e); return /(auto|scroll)/.test(s.overflowX) && e.scrollWidth > e.clientWidth + 1; }).map((e) => e.className || e.tagName);
  return { page: de.scrollWidth - de.clientWidth, body: document.body.scrollWidth - de.clientWidth, panel: panel ? panel.scrollWidth - panel.clientWidth : null, crew: crew ? crew.scrollWidth - crew.clientWidth : null, scrollers };
});

for (const theme of ['light', 'dark']) for (const [w, h] of SIZES) {
  await check(`${theme} ${w}px: crew tab has no horizontal scrollbar (page or panel), all 16 cards render`, async () => {
    const { ctx, p } = await newPage({ theme, width: w, height: h });
    await p.goto(`${base}/#/runs/${id}/crew`);
    await p.locator('article[data-agent-id="lead"]').waitFor();
    await p.waitForTimeout(500);
    ok((await p.locator('article[data-agent-id]').count()) === 16, `cards ${await p.locator('article[data-agent-id]').count()}`);
    const o = await hOverflow(p);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `crew-${theme}-${w}.png`), fullPage: true });
    ok(o.page <= 1 && o.body <= 1, `page overflows by ${o.page}/${o.body}`);
    ok((o.panel ?? 0) <= 1 && (o.crew ?? 0) <= 1, `panel overflows by ${o.panel}/${o.crew}`);
    ok(o.scrollers.length === 0, `inner horizontal scrollers: ${o.scrollers}`);
    await ctx.close();
  });

  await check(`${theme} ${w}px: every recorded parent has a visible connector joining parent and child; none for the stray agent`, async () => {
    const { ctx, p } = await newPage({ theme, width: w, height: h });
    await p.goto(`${base}/#/runs/${id}/crew`);
    await p.locator('article[data-agent-id="lead"]').waitFor();
    await p.waitForTimeout(500);
    const res = await p.evaluate(() => {
      const out = [];
      for (const e of document.querySelectorAll('[data-edge]')) {
        const [par, kid] = e.getAttribute('data-edge').split('->');
        const rc = (sel) => document.querySelector(`article[data-agent-id="${CSS.escape(sel)}"]`)?.getBoundingClientRect();
        const pr = rc(par); const kr = rc(kid); const er = e.getBoundingClientRect();
        const cs = getComputedStyle(e);
        out.push({ edge: e.getAttribute('data-edge'), er: [er.left, er.top, er.right, er.bottom], pr: pr && [pr.left, pr.top, pr.right, pr.bottom], kr: kr && [kr.left, kr.top, kr.right, kr.bottom], display: cs.display, vis: cs.visibility, op: cs.opacity });
      }
      return out;
    });
    const edges = res.map((r) => r.edge);
    const want = ['main:s-lay->lead', ...Array.from({ length: 10 }, (_, i) => `lead->h${i}`), 'h0->n1', 'h0->n2', 'n1->nn'];
    for (const w2 of want) ok(edges.includes(w2), `missing edge ${w2}`);
    ok(!edges.some((x) => x.endsWith('->stray')), 'edge for unlinked agent');
    ok(edges.length === want.length, `unexpected edges ${edges.filter((x) => !want.includes(x))}`);
    const T = 12;
    for (const r of res) {
      ok(r.display !== 'none' && r.vis !== 'hidden' && Number(r.op) > 0, `${r.edge} hidden`);
      ok(r.pr && r.kr, `${r.edge}: card missing`);
      const [l, t, rt, b] = r.er;
      ok(rt - l > 0 || b - t > 0, `${r.edge}: zero-size`);
      // The connector lies between the parent's top and the child's bottom, and within their combined horizontal range.
      ok(t >= r.pr[1] - T && b <= r.kr[3] + T, `${r.edge}: vertically not between parent and child (${r.er} vs ${r.pr} ${r.kr})`);
      ok(l >= Math.min(r.pr[0], r.kr[0]) - T && rt <= Math.max(r.pr[2], r.kr[2]) + T, `${r.edge}: horizontally off (${r.er} vs ${r.pr} ${r.kr})`);
      // Child sits below its parent (a tree), and the connector reaches the child's top edge.
      ok(r.kr[1] > r.pr[1], `${r.edge}: child not below parent`);
      ok(Math.abs(b - r.kr[1]) <= T + 6 || b >= r.kr[1] - T, `${r.edge}: connector does not reach the child's top`);
    }
    await ctx.close();
  });
}

await check('connector colour differs from the page background in light and dark (visible on both)', async () => {
  for (const theme of ['light', 'dark']) {
    const { ctx, p } = await newPage({ theme, width: 1280, height: 800 });
    await p.goto(`${base}/#/runs/${id}/crew`);
    await p.locator('[data-edge]').first().waitFor();
    const r = await p.evaluate(() => {
      const e = document.querySelector('[data-edge="lead->h0"]');
      const cs = getComputedStyle(e);
      const nodes = [e, ...e.querySelectorAll('*')];
      const cols = nodes.flatMap((n) => { const s = getComputedStyle(n); return [s.backgroundColor, s.borderTopColor, s.borderLeftColor, s.stroke, s.color]; });
      return { bg: getComputedStyle(document.body).backgroundColor, cols, w: cs.borderTopWidth + cs.borderLeftWidth };
    });
    const visible = r.cols.filter((c) => c && c !== 'none' && c !== 'rgba(0, 0, 0, 0)' && c !== r.bg);
    ok(visible.length > 0, `${theme}: no visible colour on the connector (bg ${r.bg})`);
    await ctx.close();
  }
});

await check('clicking a card shows that agent\'s own tool calls, including ones older than the last 100 run rows', async () => {
  const detail = await get(`/api/runs/${id}`);
  ok(!detail.activity.some((r) => r.toolUseId === 'h2-149'), 'sanity: h2 rows outside detail.activity');
  const { ctx, p } = await newPage({ width: 1440, height: 900 });
  await p.goto(`${base}/#/runs/${id}/crew`);
  await p.locator('article[data-agent-id="h2"]').waitFor();
  await p.locator('article[data-agent-id="h2"] button').first().click();
  const rail = p.getByRole('region', { name: 'Tool calls' });
  await rail.getByText('oldcall-149.txt').first().waitFor({ timeout: 5000 });
  ok((await rail.getByText(/other-\d+/).count()) === 0, 'other agents rows in rail');
  ok((await p.locator('article[data-agent-id="h2"] button[aria-pressed="true"]').count()) === 1, 'aria-pressed');
  // clicking elsewhere on another card switches
  await p.locator('article[data-agent-id="h3"] button').first().click();
  await rail.getByText(/other-\d+/).first().waitFor({ timeout: 5000 });
  ok((await rail.getByText('oldcall-149.txt').count()) === 0, 'stale rows from h2 after switching');
  await ctx.close();
});

await check('narrow 390px: selecting a card still works and the rail is reachable without horizontal scroll', async () => {
  const { ctx, p } = await newPage({ width: 390, height: 844 });
  await p.goto(`${base}/#/runs/${id}/crew`);
  await p.locator('article[data-agent-id="h2"]').waitFor();
  await p.locator('article[data-agent-id="h2"] button').first().click();
  await p.getByRole('region', { name: 'Tool calls' }).getByText('oldcall-149.txt').first().waitFor({ timeout: 5000 });
  const o = await hOverflow(p);
  ok(o.page <= 1 && (o.panel ?? 0) <= 1, `overflow after select ${JSON.stringify(o)}`);
  await ctx.close();
});

await check('Ledger tab renders the recorded changes (input and result), light and dark', async () => {
  const api = await get(`/api/runs/${id}/ledger`);
  ok(JSON.stringify(api).includes('feat/crew-ledger'), 'api has the change');
  for (const theme of ['light', 'dark']) {
    const { ctx, p } = await newPage({ theme, width: 1280, height: 800 });
    await p.goto(`${base}/#/runs/${id}/ledger`);
    await p.getByText(/Pushed feat\/crew-ledger/).first().waitFor({ timeout: 5000 });
    const body = await p.locator('body').textContent();
    ok(/Seeded change|9a8b7c6|ommit/.test(body), 'second change shown');
    const o = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(o <= 1, `ledger page overflows by ${o}`);
    if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `ledger-${theme}.png`), fullPage: true });
    await ctx.close();
  }
});

await finish();
