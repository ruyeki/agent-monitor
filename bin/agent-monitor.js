#!/usr/bin/env node
// agent-monitor serve | wait <run>

const [cmd, arg] = process.argv.slice(2);
const port = Number(process.env.AGENT_MONITOR_PORT) || 4747;

async function serve() {
  const { startServer } = await import('../src/server.js');
  const s = await startServer({
    port,
    dataDir: process.env.AGENT_MONITOR_HOME || undefined,
    projectsDir: process.env.AGENT_MONITOR_PROJECTS_DIR || undefined,
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

if (cmd === 'serve') await serve();
else if (cmd === 'wait' && arg) await wait(arg);
else { console.error('Usage: agent-monitor serve | wait <run>'); process.exit(2); }
