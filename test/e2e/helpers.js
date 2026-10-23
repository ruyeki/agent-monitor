// Shared helpers for the e2e script. Not a test file.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..').replace(/\\/g, '/');
export const fileUrl = (rel) => pathToFileURL(path.join(REPO, rel)).href;
export const load = (rel) => import(fileUrl(rel));
export const tmp = (prefix = 'am-') => fs.mkdtempSync(path.join(os.tmpdir(), prefix));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function until(fn, ms = 4000, step = 40) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    await sleep(step);
  }
  return last;
}

export function req(port, method, p, { body, headers = {}, rawBody } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    let data = rawBody;
    if (data === undefined && body !== undefined) {
      data = JSON.stringify(body);
      if (!('Content-Type' in h)) h['Content-Type'] = 'application/json';
    }
    if (data === undefined && !['GET', 'HEAD'].includes(method) && !('Content-Type' in h)) { data = '{}'; h['Content-Type'] = 'application/json'; }
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    if (data !== undefined) h['Content-Length'] = Buffer.byteLength(data);
    const r = http.request({ host: '127.0.0.1', port, method, path: p, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json; try { json = JSON.parse(text); } catch { /* not json */ }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    r.on('error', reject);
    if (data !== undefined) r.write(data);
    r.end();
  });
}

export async function boot(opts = {}) {
  const { startServer } = await load('src/server.js');
  const home = opts.home || tmp('am-home-');
  const projects = opts.projects || tmp('am-proj-');
  const webDir = opts.webDir || path.join(tmp('am-web-'), 'nope');
  const srv = await startServer({ port: opts.port ?? 0, dataDir: home, projectsDir: projects, webDir });
  const api = (m, p, o) => req(srv.port, m, p, o);
  return { srv, home, projects, api, port: srv.port, url: srv.url };
}

export async function mcpClient(url) {
  const { Client } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js'));
  const { StreamableHTTPClientTransport } = await import(fileUrl('node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js'));
  const client = new Client({ name: 'holdout', version: '0.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url.replace(/\/$/, '') + '/mcp')));
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { isError: !!r.isError, text: (r.content || []).map((c) => c.text).join('\n') };
  };
  return { client, call };
}

export async function freePort() {
  const net = await import('node:net');
  return new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

export const runIdOf = (text) => /^RUN (\S+)/.exec(text.split('\n')[0])?.[1];
export const hook = (port, payload) => req(port, 'POST', '/hook', { body: payload });
