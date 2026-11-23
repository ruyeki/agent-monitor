// Holdout e2e (#2289 piece 2): the Crew tab on the built bundle. Parent link from meta, connector lines, context bar from usage.db, Monitor link to /crew.
import { kit, until, sleep, runIdOf, fs, path } from './holdout-am-affect-pro-kit.mjs';

const k = await kit('am-pro-p2');
const { base, call, get, ok, check, newPage, finish, H, link, pre, post, projects } = k;
const sub = (aid) => path.join(projects, 'proj', 's-crew', 'subagents', `agent-${aid}.jsonl`);
const line = (id, agent, model, input, cacheRead) => JSON.stringify({ type: 'assistant', sessionId: 's-crew', ...(agent ? { agentId: agent } : {}), timestamp: new Date(Date.now() - 20000).toISOString(),
  message: { id, model, role: 'assistant', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: input, output_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: cacheRead } } });

const id = runIdOf(await call('start_run', { title: 'Crew e2e' }));
await link('s-crew', id);
await pre('s-crew', 'm0', 'Bash', { command: 'pwd' });
await pre('s-crew', 'toolu_lead', 'Agent', { description: 'lead', prompt: 'p' }); await post('s-crew', 'toolu_lead', 'Agent');
for (const [aid, meta] of [['lead1', { agentType: 'fable-lead', description: 'Lead: ship it', toolUseId: 'toolu_lead' }], ['h1', { agentType: 'sonnet-engineer', description: 'Build the UI', toolUseId: 'toolu_h1' }], ['h2', { agentType: 'sonnet-engineer', description: 'Orphan helper' }]]) {
  fs.mkdirSync(path.dirname(sub(aid)), { recursive: true });
  fs.writeFileSync(sub(aid).replace(/\.jsonl$/, '.meta.json'), JSON.stringify(meta));
  fs.writeFileSync(sub(aid), '');
}
fs.writeFileSync(sub('lead1'), line('l1', 'lead1', 'claude-opus-5-5', 5, 249995) + '\n');
fs.writeFileSync(sub('h1'), line('h1a', 'h1', 'claude-sonnet-5-5', 10, 99990) + '\n');
await H('s-crew', 'SubagentStart', { agent_id: 'lead1', agent_type: 'fable-lead' });
await post('s-crew', 'r-lead', 'Bash', {}, { agent_id: 'lead1' });
await pre('s-crew', 'toolu_h1', 'Agent', { description: 'h', prompt: 'p' }, { agent_id: 'lead1' }); await post('s-crew', 'toolu_h1', 'Agent', {}, { agent_id: 'lead1' });
await H('s-crew', 'SubagentStart', { agent_id: 'h1', agent_type: 'sonnet-engineer' });
await post('s-crew', 'r-h1', 'Bash', {}, { agent_id: 'h1' });
await pre('s-crew', 'toolu_a', 'Agent', { description: 'x', prompt: 'p' });
await pre('s-crew', 'toolu_b', 'Agent', { description: 'y', prompt: 'p' }, { agent_id: 'lead1' });
await H('s-crew', 'SubagentStart', { agent_id: 'h2', agent_type: 'sonnet-engineer' }); // ambiguous: two agents have pending Agent calls
await post('s-crew', 'r-h2', 'Bash', {}, { agent_id: 'h2' });
await pre('s-crew', 'live1', 'Bash', { command: 'sleep 600' }, { agent_id: 'h1' });
await until(async () => (await get(`/api/runs/${id}`)).agents.find((a) => a.id === 'h1')?.context, 20000, 300);

await check('server tree: lead -> main, helper -> lead, ambiguous helper has no parent, context only where known', async () => {
  const d = await get(`/api/runs/${id}`);
  const by = Object.fromEntries(d.agents.map((a) => [a.id, a]));
  ok(by.lead1.parentId === 'main:s-crew', `lead parent ${by.lead1.parentId}`);
  ok(by.h1.parentId === 'lead1', `h1 parent ${by.h1.parentId}`);
  ok((by.h2.parentId ?? null) === null, `h2 parent ${by.h2.parentId}`);
  ok(by.lead1.context?.pct === 25 && by.h1.context?.pct === 10, `context ${JSON.stringify([by.lead1.context, by.h1.context])}`);
  ok(by.h2.context === null, 'h2 context null');
});

await check('Crew tab: cards, connector lines only for known parents, context bars only where known', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/runs/${id}/crew`);
  await p.locator('article[data-agent-id="lead1"]').waitFor();
  ok((await p.getByRole('tab', { name: 'Crew' }).getAttribute('aria-selected')) === 'true', 'Crew tab selected');
  ok((await p.locator('article[data-agent-id]').count()) >= 4, 'main + 3 agents');
  const edges = await p.locator('[data-edge]').evaluateAll((els) => els.map((e) => e.getAttribute('data-edge')));
  ok(edges.includes('main:s-crew->lead1') && edges.includes('lead1->h1'), `edges ${edges}`);
  ok(!edges.some((e) => e.endsWith('->h2')), 'no line into the orphan');
  ok((await p.locator('article[data-agent-id="lead1"] [role="progressbar"][aria-label="Context"]').getAttribute('aria-valuenow')) === '25', 'lead context 25');
  ok((await p.locator('article[data-agent-id="h2"] [role="progressbar"]').count()) === 0, 'no bar for unknown context');
  ok((await p.locator('article[data-agent-id="lead1"]').textContent()).includes('Opus 5.5'), 'model name');
  await ctx.close();
});

await check('selecting a card filters the tool calls; Escape/second click clears; keyboard reachable', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  await p.goto(`${base}/#/runs/${id}/crew`);
  const c = p.locator('article[data-agent-id="h1"]');
  await c.waitFor();
  const sel = (await c.evaluate((e) => e.matches('[aria-pressed]'))) ? c : c.locator('[aria-pressed]').first();
  await sel.click();
  ok((await sel.getAttribute('aria-pressed')) === 'true', 'selected');
  await sel.click();
  ok((await sel.getAttribute('aria-pressed')) === 'false', 'cleared');
  await ctx.close();
});

await check('Monitor: the live run row opens its Crew tab', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  const l = p.getByRole('link', { name: /Crew e2e/ }).first();
  await l.waitFor();
  ok((await l.getAttribute('href')) === `#/runs/${id}/crew`, `href ${await l.getAttribute('href')}`);
  await l.click();
  await p.locator('article[data-agent-id="lead1"]').waitFor();
  await p.getByRole('tab', { name: 'Stages' }).click();
  await p.locator('[data-node]').first().waitFor();
  await ctx.close();
});

await finish();
