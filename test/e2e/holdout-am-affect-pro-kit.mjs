// Shared kit for the #2289 e2e holdouts (not a test itself). Boots the server on the BUILT bundle (WEB_DIR) and drives Chromium (CHROME_PATH).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { load, tmp, until, sleep, mcpClient, runIdOf, hook, req, REPO } from './helpers.js';

export { until, sleep, runIdOf, path, fs };
const require = createRequire(import.meta.url);

export async function kit(name, serverOpts = {}) {
  const { chromium } = require(path.join(REPO, 'node_modules', 'playwright-core'));
  const CHROME = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  const webDir = process.env.WEB_DIR;
  if (!webDir || !fs.existsSync(path.join(webDir, 'index.html'))) { console.error('WEB_DIR must point at a build'); process.exit(2); }
  const SHOTS = process.env.AM_PRO_SHOTS || fs.mkdtempSync(path.join(os.tmpdir(), `${name}-shots-`));
  fs.mkdirSync(SHOTS, { recursive: true });
  const projects = tmp('am-pro-proj-');
  const { startServer } = await load('src/server.js');
  const srv = await startServer({ port: 0, dataDir: tmp('am-pro-home-'), projectsDir: projects, webDir, ...serverOpts });
  const base = srv.url.replace(/\/$/, '');
  const mcp = await mcpClient(srv.url);
  const call = async (n, a) => (await mcp.call(n, a)).text;
  const get = async (p) => (await req(srv.port, 'GET', p)).json;
  const tp = (s) => path.join(projects, 'proj', `${s}.jsonl`);
  const H = (s, ev, extra = {}) => { fs.mkdirSync(path.dirname(tp(s)), { recursive: true }); if (!fs.existsSync(tp(s))) fs.writeFileSync(tp(s), ''); return hook(srv.port, { hook_event_name: ev, session_id: s, transcript_path: tp(s), cwd: '/x', ...extra }); };
  const link = (s, id) => H(s, 'PostToolUse', { tool_name: 'mcp__agent-monitor__start_run', tool_input: { title: id }, tool_use_id: `link-${s}`, tool_response: { content: [{ type: 'text', text: `RUN ${id} · stage frame (Frame) · round 0/5 · status active` }] } });
  const pre = (s, id, tool, input, extra = {}) => H(s, 'PreToolUse', { tool_name: tool, tool_input: input, tool_use_id: id, ...extra });
  const post = (s, id, tool, resp = { stdout: '' }, extra = {}) => H(s, 'PostToolUse', { tool_name: tool, tool_input: {}, tool_response: resp, tool_use_id: id, ...extra });
  const browser = await chromium.launch({ executablePath: CHROME, headless: true });
  const results = []; const pageErrors = []; const requests = [];
  let page;
  const ok = (c, m) => { if (!c) throw new Error(m); };
  const check = async (n, fn) => {
    try { await fn(); results.push([n, 'PASS', '']); } catch (e) {
      results.push([n, 'FAIL', String(e.message || e).split('\n')[0].slice(0, 300)]);
      try { await page?.screenshot({ path: path.join(SHOTS, `FAIL-${n.replace(/\W+/g, '_').slice(0, 60)}.png`) }); } catch { /* ignore */ }
    }
  };
  const newPage = async ({ theme = 'light', width = 1300, height = 900, init } = {}) => {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
    await ctx.addInitScript((t) => { try { localStorage.setItem('agent-monitor-theme', t); } catch { /* */ } }, theme);
    if (init) await ctx.addInitScript(init);
    ctx.setDefaultTimeout(6000);
    const p = await ctx.newPage();
    p.on('request', (r) => requests.push(r.url()));
    p.on('pageerror', (e) => pageErrors.push(String(e)));
    page = p;
    return { ctx, p };
  };
  const finish = async () => {
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
    console.log(`screenshots: ${SHOTS}`);
    process.exit(results.some((r) => r[1] === 'FAIL') ? 1 : 0);
  };
  return { srv, base, projects, call, get, H, link, pre, post, browser, check, ok, newPage, finish, tp };
}
