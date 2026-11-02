#!/usr/bin/env node
// agent-monitor serve | wait <run> | hook codex [--port n]

const [cmd, arg] = process.argv.slice(2);
const port = Number(process.env.AGENT_MONITOR_PORT) || 4747;

async function serve() {
  process.env.NoDefaultCurrentDirectoryInExePath = '1'; // Windows must not run a planted exe in the cwd before PATH
  const { startServer } = await import('../src/server.js');
  const s = await startServer({
    port,
    dataDir: process.env.AGENT_MONITOR_HOME || undefined,
    projectsDir: process.env.AGENT_MONITOR_PROJECTS_DIR || undefined,
    // Only the real server may start Codex; AGENT_MONITOR_CODEX=off turns the hand-off off.
    codex: process.env.AGENT_MONITOR_CODEX === 'off' ? null : { command: process.env.AGENT_MONITOR_CODEX || 'codex' },
  });
  console.log(`Agent Monitor listening on ${s.url}`);
}

// Long-polls until Ryan answers, then prints one JSON line. Retries forever while the server is down.
async function wait(run) {
  const base = process.env.AGENT_MONITOR_URL || `http://127.0.0.1:${port}`;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (;;) {
    let res;
    try {
      res = await fetch(`${base}/api/runs/${encodeURIComponent(run)}/wait?timeout=25000`);
    } catch {
      await sleep(2000);
      continue;
    }
    if (res.status === 404) { console.error(`Agent Monitor has no run '${run}'.`); process.exit(1); }
    if (!res.ok) { await sleep(2000); continue; }
    let data;
    try { data = await res.json(); } catch { await sleep(2000); continue; }
    if (data.done) {
      console.log(JSON.stringify({ run, action: data.action, text: data.text, stage: data.stage, status: data.status }));
      return;
    }
  }
}

// Codex hook relay: stdin -> POST /hook/codex. Fail open: always exit 0, print only a non-empty answer.
async function hookCodex() {
  const i = process.argv.indexOf('--port');
  const hookPort = (i > 0 && Number(process.argv[i + 1])) || port;
  try {
    let body = '';
    for await (const c of process.stdin) body += c;
    const res = await fetch(`http://127.0.0.1:${hookPort}/hook/codex`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(1000),
    });
    const out = await res.json();
    if (out && typeof out === 'object' && Object.keys(out).length) console.log(JSON.stringify(out));
  } catch { /* fail open */ }
  process.exit(0);
}

if (cmd === 'serve') await serve();
else if (cmd === 'wait' && arg) await wait(arg);
else if (cmd === 'hook' && arg === 'codex') await hookCodex();
else { console.error('Usage: agent-monitor serve | wait <run> | hook codex [--port n]'); process.exit(2); }
