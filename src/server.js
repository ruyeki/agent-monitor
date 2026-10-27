// One HTTP server on 127.0.0.1: REST + SSE (/api), MCP (/mcp), hooks (/hook) and the built UI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.js';
import { createHooks } from './hooks.js';
import { createMcpHandler } from './mcp.js';
import { openUsage } from './usage.js';
import { usageStats, versionStats, runAttribution } from './stats.js';
import { toTokens, emptyAcc } from './attribution.js';

const MAX_BODY = 5 * 1024 * 1024;
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
const NO_BUILD = '<!doctype html><meta charset="utf-8"><title>Agent Monitor</title><p>Agent Monitor is running, but the UI is not built. Run <code>npm run build</code>.</p>';

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

function send(res, status, body, type = 'application/json') {
  const data = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(data), 'Cache-Control': 'no-store' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'Body too large.'));
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const parseJson = (raw) => {
  if (!raw.trim()) return {};
  try { return JSON.parse(raw); } catch { throw new HttpError(400, 'Body is not valid JSON.'); }
};

export async function startServer({
  port = 4747, dataDir = path.join(os.homedir(), '.claude', 'agent-monitor'),
  projectsDir = path.join(os.homedir(), '.claude', 'projects'), webDir = fileURLToPath(new URL('../web/dist', import.meta.url)),
  usageIntervalMs = 5000,
} = {}) {
  const store = openStore(dataDir);
  const usage = await openUsage({ dataDir, projectsDir });
  let hooks;
  const streams = new Set();
  let hostPorts = [];
  let mcp;

  const handleApi = async (req, res, url) => {
    const m = (re) => re.exec(url.pathname);
    const method = req.method;
    const body = () => readBody(req).then(parseJson);
    let g;

    if (method === 'GET' && url.pathname === '/api/runs') return send(res, 200, store.listRuns());
    if (method === 'GET' && (g = m(/^\/api\/runs\/([^/]+)$/))) {
      const d = store.detail(decodeURIComponent(g[1]));
      return d ? send(res, 200, withTokens(d)) : send(res, 404, { error: 'No such run.' });
    }
    if (method === 'POST' && (g = m(/^\/api\/runs\/([^/]+)\/respond$/))) {
      const b = await body();
      const r = store.respond(decodeURIComponent(g[1]), { action: b.action, text: typeof b.text === 'string' ? b.text : '' });
      return send(res, r.notFound ? 404 : r.error ? 400 : 200, r.error ? { error: r.error } : r.run);
    }
    if (method === 'POST' && (g = m(/^\/api\/runs\/([^/]+)\/stop$/))) {
      const r = store.stopRun(decodeURIComponent(g[1]));
      return send(res, r.notFound ? 404 : r.error ? 400 : 200, r.error ? { error: r.error } : r.run);
    }
    if (method === 'GET' && (g = m(/^\/api\/runs\/([^/]+)\/wait$/))) return handleWait(req, res, decodeURIComponent(g[1]), url);

    if (method === 'GET' && url.pathname === '/api/workflow') {
      return send(res, 200, { published: store.published(), draft: store.draft() });
    }
    if (method === 'PUT' && url.pathname === '/api/workflow/draft') {
      const r = store.saveDraft((await body()).workflow);
      return send(res, r.error ? 400 : 200, r.error ? { error: r.error } : r.draft);
    }
    if (method === 'DELETE' && url.pathname === '/api/workflow/draft') return send(res, 200, store.resetDraft());
    if (method === 'POST' && url.pathname === '/api/workflow/publish') {
      const r = store.publish();
      return send(res, r.errors ? 400 : 200, r);
    }
    if (method === 'GET' && url.pathname === '/api/workflow/versions') {
      const stats = new Map(versionStats(store, usage).map((v) => [v.version, v]));
      return send(res, 200, store.versions().map((v) => {
        const { finishedRuns, avgTokens, avgDurationMs } = stats.get(v.version);
        return { ...v, stats: { finishedRuns, avgTokens, avgDurationMs } };
      }));
    }
    if (method === 'GET' && (g = m(/^\/api\/workflow\/versions\/(\d+)$/))) {
      const wf = store.version(Number(g[1]));
      return wf ? send(res, 200, { version: Number(g[1]), workflow: wf }) : send(res, 404, { error: 'No such version.' });
    }
    if (method === 'POST' && (g = m(/^\/api\/workflow\/versions\/(\d+)\/load$/))) {
      const d = store.loadVersion(Number(g[1]));
      return d ? send(res, 200, d) : send(res, 404, { error: 'No such version.' });
    }
    if (method === 'GET' && url.pathname === '/api/stats/usage') {
      const days = url.searchParams.get('days') === '30' ? 30 : 90;
      return send(res, 200, usageStats({ usage, prices: usage.prices(), days }));
    }
    if (method === 'GET' && url.pathname === '/api/stats/versions') return send(res, 200, versionStats(store, usage));
    if (method === 'GET' && url.pathname === '/api/prices') return send(res, 200, usage.prices());
    if (method === 'PUT' && url.pathname === '/api/prices') {
      const r = usage.setPrices((await body())?.prices);
      if (!r.error) store.bus.emit('change', { type: 'usage' }); // cost figures change with the prices
      return send(res, r.error ? 400 : 200, r);
    }
    if (method === 'GET' && url.pathname === '/api/events') return handleEvents(req, res);
    return send(res, 404, { error: 'Not found.' });
  };

  // Adds indexer-based token numbers to a run detail: per node, per agent and run-wide.
  function withTokens(d) {
    const att = runAttribution(store, usage, d.run.id);
    for (const [id, t] of Object.entries(att.nodes)) (d.nodes[id] ??= { visits: 0, durationMs: 0 }).tokens = t;
    const none = toTokens(emptyAcc());
    d.agents = d.agents.map((a) => ({ ...a, tokens: (a.id.startsWith('main:') ? att.mainBySession[a.id.slice(5)] : att.agents[a.id]?.tokens) ?? none }));
    d.tokens = { nodes: att.nodes, main: att.main, unattributed: att.unattributed, total: att.total };
    return d;
  }

  // Long poll: answer as soon as the run is no longer waiting on Ryan.
  async function handleWait(req, res, id, url) {
    if (!store.getRun(id)) return send(res, 404, { error: 'No such run.' });
    const ms = Math.min(Math.max(Number(url.searchParams.get('timeout')) || 25000, 0), 60000);
    const deadline = Date.now() + ms;
    let gone = false;
    res.on('close', () => { gone = true; });
    while (!gone && store.getRun(id).status === 'waiting') {
      const left = deadline - Date.now();
      if (left <= 0) return send(res, 200, { done: false });
      await new Promise((resolve) => {
        const finish = () => { clearTimeout(t); store.bus.off('change', onChange); res.off('close', finish); resolve(); };
        const onChange = (e) => { if (e.runId === id) finish(); };
        const t = setTimeout(finish, left);
        store.bus.on('change', onChange);
        res.on('close', finish);
      });
    }
    if (gone) return;
    const run = store.summary(store.getRun(id));
    const a = JSON.parse(store.getRun(id).answer_json ?? 'null');
    return send(res, 200, { done: true, run, action: a?.action ?? null, text: a?.text ?? '', stage: run.stage, status: run.status });
  }

  function handleEvents(req, res) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(': connected\n\n');
    const onChange = (e) => res.write(`data: ${JSON.stringify(e)}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), 25000);
    store.bus.on('change', onChange);
    streams.add(res);
    res.on('close', () => { clearInterval(beat); store.bus.off('change', onChange); streams.delete(res); });
  }

  function serveStatic(req, res, url) {
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found.' });
    let rel;
    try { rel = decodeURIComponent(url.pathname); } catch { return send(res, 400, { error: 'Bad path.' }); }
    const root = path.resolve(webDir);
    let file = path.resolve(root, `.${rel}`);
    if (file !== root && !file.startsWith(root + path.sep)) return send(res, 403, { error: 'Forbidden.' });
    let data;
    try {
      if (fs.statSync(file).isDirectory()) throw new Error('directory');
    } catch { file = path.join(root, 'index.html'); }
    try { data = fs.readFileSync(file); } catch { return send(res, 200, NO_BUILD, 'text/html; charset=utf-8'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Content-Length': data.length });
    res.end(data);
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const refuse = (status, error) => { res.setHeader('Connection', 'close'); return send(res, status, { error }); }; // body left unread: drop the connection
    if (!hostPorts.includes(req.headers.host)) return refuse(403, 'Bad Host header.');
    const origin = req.headers.origin;
    if (origin !== undefined && !hostPorts.some((h) => origin === `http://${h}`)) return refuse(403, 'Bad Origin header.');
    if (['POST', 'PUT', 'DELETE'].includes(req.method) && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
      return refuse(415, 'Content-Type must be application/json.');
    }

    if (url.pathname === '/hook') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });
      let out = {};
      try { out = hooks.handle(JSON.parse(await readBody(req))); } catch { /* fail open */ }
      return send(res, 200, out);
    }
    if (url.pathname === '/mcp') {
      if (req.method !== 'POST') return send(res, 405, { error: 'POST only.' });
      return mcp(req, res, await readBody(req).then(parseJson));
    }
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStatic(req, res, url);
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => {
      if (res.headersSent) return res.end();
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 413) res.setHeader('Connection', 'close'); // drop the rest of the oversized upload
      send(res, status, { error: status === 500 ? 'Internal error.' : e.message });
    });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actual = server.address().port;
  hostPorts = [`127.0.0.1:${actual}`, `localhost:${actual}`];
  hooks = createHooks(store, { projectsDir, port: actual });
  mcp = createMcpHandler(store, hostPorts);
  // The first scan (backfill) runs in the background; listen() has already resolved.
  usage.start({ intervalMs: usageIntervalMs, onScan: (r) => { if (r.newMessages > 0) store.bus.emit('change', { type: 'usage' }); } });

  return {
    port: actual, url: `http://127.0.0.1:${actual}`, store, usage,
    close: () => new Promise((resolve) => {
      for (const s of streams) s.end();
      server.close(() => { usage.close().then(() => { store.close(); resolve(); }); });
      server.closeAllConnections();
    }),
  };
}
