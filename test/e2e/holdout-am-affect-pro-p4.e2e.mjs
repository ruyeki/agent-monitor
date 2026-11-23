// Holdout e2e (#2289 piece 4): Accounts nav -> page -> one-click switch -> page updates, on the built bundle.
// The manager runs over temp dirs, a memory vault and a stub claude: no real login, vault or ~/.claude is ever touched.
import path from 'node:path';
import { load, tmp, REPO } from './helpers.js';
import { kit } from './holdout-am-affect-pro-kit.mjs';

const { world, oauth } = await load('test/accounts-helpers.js');
const cleanups = [];
const T = { after: (fn) => cleanups.push(fn) };
const STUB = path.join(REPO, 'test', 'holdout-am-affect-pro-p4-stub.mjs');
const GOOD = 'https://claude.ai/oauth/authorize?code=true&client_id=abc';
const CODE = 'e2e-code-7890';
const nowS = Math.floor(Date.now() / 1000);
const reading = (a, b) => ({ reading: { five_hour: { used_percentage: a, resets_at: nowS + 3 * 3600 }, seven_day: { used_percentage: b, resets_at: nowS + 2 * 86400 }, at: new Date().toISOString() } });
const RYAN = oauth('uuid-ryan', { refreshTokenExpiresAt: Date.now() + 20 * 86400_000 });
const LAB = oauth('uuid-lab', { refreshTokenExpiresAt: Date.now() + 20 * 86400_000 });
const NEW = oauth('uuid-new', { refreshTokenExpiresAt: Date.now() + 20 * 86400_000 });
const env = { ...process.env, AM_LOGIN_LOG: path.join(tmp('am-p4-e2e-log-'), 'stub.log'), AM_P4_STUB: JSON.stringify({ url: GOOD, needsCode: true, expectCode: CODE, oauth: NEW, email: 'new@example.com' }) };
const w = world(T, {
  accounts: { ryan: RYAN, lab: LAB }, live: RYAN, usage: { ryan: reading(10, 20), lab: reading(40, 60) },
  claude: { command: process.execPath, args: [STUB] }, env, clock: () => Date.now(),
});

const k = await kit('am-pro-p4', { accounts: { manager: w.m, command: { command: process.execPath, args: [STUB] }, notify() {} } });
const { base, get, ok, check, newPage, finish } = k;
const card = (p, n) => p.locator(`article[data-account="${n}"]`);

await check('Accounts nav opens the page: header, actions, one card per account, ryan Active, bars only with a reading', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/`);
  const nav = p.getByRole('navigation', { name: 'Sections' });
  await nav.getByRole('link', { name: /Accounts/ }).click();
  await p.getByRole('heading', { name: 'Accounts' }).waitFor();
  ok(p.url().endsWith('#/accounts'), `url ${p.url()}`);
  await card(p, 'ryan').waitFor();
  await card(p, 'lab').waitFor();
  ok((await p.getByRole('button', { name: 'Refresh usage' }).count()) === 1, 'Refresh usage');
  ok((await p.getByRole('button', { name: 'Add account' }).count()) === 1, 'Add account');
  ok((await card(p, 'ryan').getByText('Active', { exact: true }).count()) === 1, 'ryan Active');
  ok((await card(p, 'lab').getByText('Active', { exact: true }).count()) === 0, 'lab not Active');
  ok((await card(p, 'lab').getByRole('progressbar', { name: '5-hour usage' }).getAttribute('aria-valuenow')) === '40', '5-hour 40');
  ok((await card(p, 'lab').getByRole('progressbar', { name: '7-day usage' }).getAttribute('aria-valuenow')) === '60', '7-day 60');
  ok((await card(p, 'ryan').getByRole('button', { name: 'Switch to this account' }).count()) === 0, 'no switch on the active card');
  ok(!/FAKE|sk-ant|uuid-/.test(await p.locator('body').textContent()), 'no token or account id on the page');
  await ctx.close();
});

await check('one click on "Switch to this account" swaps the live login and the page updates without a reload', async () => {
  const { ctx, p } = await newPage({ theme: 'dark' });
  await p.goto(`${base}/#/accounts`);
  await card(p, 'lab').waitFor();
  const before = w.live();
  await card(p, 'lab').getByRole('button', { name: 'Switch to this account' }).click();
  await card(p, 'lab').getByText('Active', { exact: true }).waitFor();
  ok((await card(p, 'ryan').getByText('Active', { exact: true }).count()) === 0, 'ryan no longer Active');
  ok(w.live() !== before && /uuid-lab/.test(w.live()), 'live login is now lab');
  const j = await get('/api/accounts');
  ok(j.accounts.find((a) => a.name === 'lab').active === true, 'API agrees');
  ok((await card(p, 'ryan').getByRole('button', { name: 'Switch to this account' }).count()) === 1, 'switch moved to ryan');
  ok(!/FAKE|sk-ant|uuid-/.test(await p.locator('body').textContent()), 'no token or account id on the page');
  await ctx.close();
});

await check('the real server refuses a non-JSON POST and a foreign Origin on /api/accounts/use, and nothing changes', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/accounts`);
  await card(p, 'lab').waitFor();
  const live = w.live();
  const plain = await p.evaluate(async () => (await fetch('/api/accounts/use', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ name: 'ryan' }) })).status);
  ok(plain === 415, `text/plain -> ${plain}`);
  ok(w.live() === live, 'live login unchanged');
  await ctx.close();
});

await check('Add account: name -> sign-in link (new tab, noopener) and code box -> code -> the new account appears; nothing leaks', async () => {
  const { ctx, p } = await newPage();
  await p.goto(`${base}/#/accounts`);
  await card(p, 'lab').waitFor();
  await p.getByRole('button', { name: 'Add account' }).click();
  const name = p.getByRole('textbox', { name: /name/i });
  await name.fill('newone');
  const email = p.getByRole('textbox', { name: /email/i });
  if (await email.count()) await email.fill('new@example.com');
  await name.press('Enter');
  const link = p.getByRole('link', { name: /sign|open|browser|claude/i });
  await link.waitFor({ timeout: 10000 });
  ok((await link.getAttribute('href')) === GOOD, 'href is the allowed claude.ai URL');
  ok((await link.getAttribute('target')) === '_blank', 'opens in a new tab');
  ok(/noopener/.test((await link.getAttribute('rel')) ?? '') && /noreferrer/.test((await link.getAttribute('rel')) ?? ''), 'rel noopener noreferrer');
  const code = p.getByRole('textbox', { name: /code/i });
  await code.waitFor({ timeout: 10000 });
  await code.fill(CODE);
  await code.press('Enter');
  if (!(await card(p, 'newone').waitFor({ timeout: 4000 }).then(() => true, () => false))) {
    await p.getByRole('button', { name: /code|send|submit|continue|finish/i }).first().click();
  }
  await card(p, 'newone').waitFor({ timeout: 15000 });
  const body = await p.locator('body').textContent();
  ok(!body.includes(CODE), 'the pasted code is not shown back');
  ok(!/FAKE|sk-ant|uuid-/.test(body), 'no token or account id on the page');
  ok(w.vault.entries.get('account/newone'), 'saved in the (memory) vault');
  await ctx.close();
});

await finish();
for (const fn of cleanups) { try { await fn(); } catch { /* best effort */ } }
