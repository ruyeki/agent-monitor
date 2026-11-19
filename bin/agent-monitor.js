#!/usr/bin/env node
// agent-monitor serve | wait <run> | hook codex [--port n] | accounts <add|list|use|remove|refresh> | statusline-record [--quiet]

const [cmd, arg] = process.argv.slice(2);
const port = Number(process.env.AGENT_MONITOR_PORT) || 4747;

// The Claude account switcher: the manager over the vault and the login file, plus the resolved claude command.
// AGENT_MONITOR_ACCOUNTS=off turns it off (limits then go straight to Codex).
async function accountsOptions() {
  const { resolveClaude } = await import('../src/exe.js');
  const { defaults } = await import('../src/accounts/paths.js');
  const { createVault } = await import('../src/accounts/vault.js');
  const d = defaults(process.env);
  const vault = createVault({ prefix: d.vaultPrefix });
  const claude = resolveClaude(process.env.AGENT_MONITOR_CLAUDE || 'claude', process.env);
  return { ...d, vault, claude };
}

async function serve() {
  process.env.NoDefaultCurrentDirectoryInExePath = '1'; // Windows must not run a planted exe in the cwd before PATH
  const { startServer } = await import('../src/server.js');
  let accounts = null;
  if (process.env.AGENT_MONITOR_ACCOUNTS !== 'off') {
    // Rotation is optional: if it cannot be set up the server still starts, with rotation off.
    try {
      const { createAccounts } = await import('../src/accounts/index.js');
      const { desktopNotify } = await import('../src/notify.js');
      const o = await accountsOptions();
      const manager = createAccounts({ dataDir: o.dataDir, home: o.home, claudeJson: o.claudeJson, vault: o.vault, claude: o.claude });
      manager.startSync();
      accounts = { manager, command: o.claude, notify: desktopNotify };
    } catch (e) {
      console.error(`Account rotation off: ${e.message}`);
    }
  }
  const s = await startServer({
    port,
    dataDir: process.env.AGENT_MONITOR_HOME || undefined,
    projectsDir: process.env.AGENT_MONITOR_PROJECTS_DIR || undefined,
    // Only the real server may start Codex; AGENT_MONITOR_CODEX=off turns the hand-off off.
    codex: process.env.AGENT_MONITOR_CODEX === 'off' ? null : { command: process.env.AGENT_MONITOR_CODEX || 'codex' },
    accounts,
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
else if (cmd === 'accounts') {
  const { runAccountsCli } = await import('../src/accounts/cli.js');
  try {
    const { dataDir, home, claudeJson, vault, claude } = await accountsOptions();
    process.exitCode = await runAccountsCli(process.argv.slice(3), { dataDir, home, claudeJson, vault, claude });
  } catch (e) {
    console.error(`accounts: ${e.message}`);
    process.exitCode = 1;
  }
} else if (cmd === 'statusline-record') await (await import('../src/accounts/record.js')).main(process.argv.slice(3));
else if (cmd === 'wait' && arg) await wait(arg);
else if (cmd === 'hook' && arg === 'codex') await hookCodex();
else { console.error('Usage: agent-monitor serve | wait <run> | hook codex [--port n] | accounts <command> | statusline-record [--quiet]'); process.exit(2); }
