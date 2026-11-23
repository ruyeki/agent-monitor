// Holdout e2e (#2289 piece 1) on the built bundle: Fleet toggle persists across reload, quick answer moves a waiting run on, storage that throws, run header.
// Run: WEB_DIR=<built dist> CHROME_PATH=<chromium> node --disable-warning=ExperimentalWarning test/e2e/holdout-am-affect-pro-p1.e2e.mjs
import { kit, until, sleep, runIdOf } from './holdout-am-affect-pro-kit.mjs';

const k = await kit('am-pro-p1');
const { base, call, get, ok, check, newPage, finish, H, link, pre } = k;

const waiter = runIdOf(await call('start_run', { title: 'Fleet waiter' }));
await call('complete_stage', { run: waiter, stage: 'frame', outcome: 'done' });
await sleep(60);
const waiter2 = runIdOf(await call('start_run', { title: 'Second waiter' }));
await call('complete_stage', { run: waiter2, stage: 'frame', outcome: 'done' });
const busy = runIdOf(await call('start_run', { title: 'Busy fleet run' }));
await link('s-busy', busy);
await pre('s-busy', 'b1', 'Bash', { command: 'sleep 600' });
ok((await get('/api/runs')).filter((r) => r.status === 'waiting').length === 2, 'two waiting runs seeded');
const statusOf = async (id) => (await get('/api/runs')).find((r) => r.id === id)?.status;

await check('Monitor shows the List/Fleet group with List selected; the layout survives a reload after choosing Fleet', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  const g = p.getByRole('group', { name: 'Layout' });
  await g.waitFor();
  ok((await g.getByRole('button', { name: 'List' }).getAttribute('aria-pressed')) === 'true', 'List should be pressed by default');
  await g.getByRole('button', { name: 'Fleet' }).click();
  await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').first().waitFor();
  ok((await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').count()) === 3, `3 live cards expected, got ${await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').count()}`);
  await p.reload();
  await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').first().waitFor({ timeout: 8000 });
  ok((await p.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Fleet' }).getAttribute('aria-pressed')) === 'true', 'Fleet should still be pressed after reload');
  await p.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'List' }).click();
  await p.reload();
  await p.getByRole('group', { name: 'Layout' }).waitFor();
  ok((await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').count()) === 0, 'back to list after choosing List');
  await ctx.close();
});

await check('quick answer on a needs-you card moves the waiting run on without leaving the page', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  await p.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Fleet' }).click();
  const card = p.locator(`article[data-run-id="${waiter}"]`);
  await card.waitFor();
  const first = (await get('/api/runs')).find((r) => r.id === waiter).actions[0].label;
  ok(first, 'run has gate actions');
  ok((await card.textContent()).includes('Fleet waiter'), 'card shows the title');
  await card.getByRole('button', { name: first, exact: true }).click();
  ok(await until(async () => (await statusOf(waiter)) !== 'waiting', 6000, 100), 'run should leave waiting after the quick answer');
  ok(p.url().includes('#/'), 'still on the monitor');
  await until(async () => (await p.locator(`article[data-run-id="${waiter}"] button`, { hasText: first }).count()) === 0, 6000, 100);
  ok((await statusOf(waiter2)) === 'waiting', 'the other waiting run is untouched');
  await ctx.close();
});

await check('a card toggles its crew strip (aria-expanded) and Escape closes it', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  await p.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Fleet' }).click();
  const t = p.locator(`article[data-run-id="${busy}"] [aria-expanded]`).first();
  await t.waitFor();
  ok((await t.getAttribute('aria-expanded')) === 'false', 'closed first');
  await t.click();
  ok((await t.getAttribute('aria-expanded')) === 'true', 'open after click');
  await p.keyboard.press('Escape');
  ok((await t.getAttribute('aria-expanded')) === 'false', 'closed by Escape');
  await ctx.close();
});

await check('with localStorage throwing, the Monitor still renders and Fleet still works', async () => {
  const { ctx, p } = await newPage({ init: () => { Storage.prototype.getItem = () => { throw new Error('denied'); }; Storage.prototype.setItem = () => { throw new Error('denied'); }; } });
  await p.goto(`${base}/#/`);
  const g = p.getByRole('group', { name: 'Layout' });
  await g.waitFor();
  await g.getByRole('button', { name: 'Fleet' }).click();
  await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').first().waitFor();
  await ctx.close();
});

await check('run header: Monitor breadcrumb goes home, Stop run only for a live run, Stages tab selected on the bare URL', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/runs/${busy}`);
  await p.getByRole('heading', { level: 1, name: /Busy fleet run/ }).waitFor();
  ok((await p.getByRole('tab', { name: 'Stages' }).getAttribute('aria-selected')) === 'true', 'Stages selected');
  ok((await p.getByRole('button', { name: /Stop run/i }).count()) >= 1, 'Stop run for a live run');
  ok((await p.getByText(/Back to monitor/i).count()) === 0, 'old back link gone');
  await p.getByRole('navigation', { name: 'Breadcrumb' }).getByRole('link', { name: 'Monitor' }).click();
  await p.waitForURL(/#\/$/);
  await ctx.close();
});

await check('dark and light both render the Fleet without horizontal scroll at 390 px', async () => {
  for (const theme of ['light', 'dark']) {
    const { ctx, p } = await newPage({ theme, width: 390, height: 800 });
    await p.goto(`${base}/#/`);
    await p.getByRole('group', { name: 'Layout' }).getByRole('button', { name: 'Fleet' }).click();
    await p.locator('article[data-run-id]:not([aria-label^="Waiting on you"])').first().waitFor();
    const over = await p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    ok(over <= 1, `${theme}: horizontal overflow ${over}px`);
    await ctx.close();
  }
});

await finish();
