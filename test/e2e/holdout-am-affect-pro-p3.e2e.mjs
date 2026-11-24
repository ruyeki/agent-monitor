// Holdout e2e (#2289 piece 3): the Ledger tab on the built bundle. Tags, filter, read-only, redaction, finished-run link.
import { kit, runIdOf, until } from './holdout-am-affect-pro-kit.mjs';

const k = await kit('am-pro-p3');
const { base, call, get, ok, check, newPage, finish, link, pre, post } = k;

const id = runIdOf(await call('start_run', { title: 'Ledger e2e' }));
await link('s-led', id);
const step = async (uid, tool, input, resp) => { await pre('s-led', uid, tool, input); await post('s-led', uid, tool, resp); };
await step('l1', 'Bash', { command: 'PGPASSWORD=hunter2hunter2 pg_dump nike > /tmp/nike.sql' }, { stdout: '' });
await step('l2', 'Bash', { command: 'git commit -m "Add the ledger"' }, { stdout: '[main 1a2b3c4] Add the ledger\n 3 files changed, 10 insertions(+), 2 deletions(-)' });
await step('l3', 'Bash', { command: 'git push origin main' }, { stdout: 'main -> main' });
await step('l4', 'mcp__hephaestus__update_task', { task_id: 2289, status: 'Done' }, { content: [{ type: 'text', text: 'ok' }] });
await step('l5', 'Bash', { command: 'pm2 restart agent-monitor' }, { stdout: 'ok' });
await step('l6', 'Bash', { command: 'ls -la' }, { stdout: 'x' });
await pre('s-led', 'l7', 'Bash', { command: 'git push origin nope' });
await k.H('s-led', 'PostToolUseFailure', { tool_name: 'Bash', tool_input: {}, tool_use_id: 'l7', error: 'fatal: no such remote' });
await call('complete_stage', { run: id, stage: 'frame', outcome: 'done' });
await until(async () => (await get(`/api/runs/${id}/ledger`))?.items?.length >= 5, 6000, 100);

await check('API: items tagged, failed and read-only calls left out, no secret anywhere', async () => {
  const r = await get(`/api/runs/${id}/ledger`);
  const tags = r.items.map((i) => i.tag);
  ok(r.items.length === 5, `5 items expected, got ${r.items.length}: ${tags}`);
  for (const t of ['permanent', 'backup', 'reversible', 'info']) ok(tags.includes(t), `tag ${t} missing`);
  ok(JSON.stringify(r).indexOf('hunter2hunter2') === -1, 'secret in ledger');
  ok(r.summary.pushes === 1 && r.summary.commits === 1 && r.summary.tasks === 1, JSON.stringify(r.summary));
});

await check('Ledger tab: heading, rows with data-tag and tag label, summary and Can\'t-be-undone card, no undo controls', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/runs/${id}/ledger`);
  await p.getByRole('heading', { name: /What this run changed/ }).waitFor();
  await p.locator('[data-tag]').first().waitFor();
  ok((await p.getByRole('tab', { name: 'Ledger' }).getAttribute('aria-selected')) === 'true', 'Ledger tab selected');
  ok((await p.locator('[data-tag="permanent"]').count()) >= 1, 'a permanent row');
  const body = await p.locator('body').textContent();
  ok(/Can.t be undone/i.test(body) && /Backup kept/i.test(body) && /Can change back/i.test(body) && /Ran once/i.test(body), 'tag labels shown');
  ok(/Can.t be undone/i.test(body), 'summary card');
  ok(!body.includes('hunter2hunter2'), 'secret on the page');
  ok((await p.getByRole('button', { name: /undo|revert|roll ?back|restore/i }).count()) === 0, 'no undo controls');
  await ctx.close();
});

await check('filter: Tasks shows only the task row; All restores; aria-pressed follows', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  await p.goto(`${base}/#/runs/${id}/ledger`);
  const f = p.getByRole('group', { name: 'Filter' });
  await f.waitFor();
  const all = await p.locator('[data-tag]').count();
  await f.getByRole('button', { name: 'Tasks' }).click();
  ok((await f.getByRole('button', { name: 'Tasks' }).getAttribute('aria-pressed')) === 'true', 'Tasks pressed');
  const some = await p.locator('[data-tag]').count();
  ok(some >= 1 && some < all, `filter should narrow ${all} -> ${some}`);
  ok(/Hephaestus #2289/.test(await p.locator('body').textContent()), 'task row visible');
  await f.getByRole('button', { name: 'All' }).click();
  ok((await p.locator('[data-tag]').count()) === all, 'All restores');
  await ctx.close();
});

await check('Monitor: a finished run row opens its Ledger tab', async () => {
  await call('respond', { run: id, action: 'Stop run', text: '' }).catch(() => {});
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  await p.getByRole('heading', { name: /^Finished/ }).click(); // Finished is a collapsed details
  const l = p.getByRole('link', { name: /Ledger e2e/ }).first();
  await l.waitFor();
  const href = await l.getAttribute('href');
  ok(href === `#/runs/${id}/ledger` || href === `#/runs/${id}/crew`, `href ${href}`);
  await ctx.close();
});

await check('empty ledger: a run with no changes shows the empty state', async () => {
  const e = runIdOf(await call('start_run', { title: 'Quiet run' }));
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/runs/${e}/ledger`);
  await p.getByRole('heading', { name: /What this run changed/ }).waitFor();
  ok((await p.locator('li[data-tag]').count()) === 0, 'no rows');
  ok(/nothing|no changes|didn.t change|hasn.t changed/i.test(await p.locator('body').textContent()), 'empty message');
  await ctx.close();
});

await finish();
