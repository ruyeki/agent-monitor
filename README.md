# Agent Monitor

A small app I use at work that allows me to monitor my agents. I can see what step in my workflow the agents are currently in, how many tokens they've been using at each step, what decisions they've made, etc. Also, I can easily edit and optimize my workflows with React Flow. 

## Requirements

- Node 22.14 or newer (it uses `node:sqlite`)
- Claude Code, for the hooks and the MCP server

## Run it

```
npm install
npm run build
npm start
```

It listens on 127.0.0.1:4747 only. Open http://127.0.0.1:4747. Data lives in `~/.claude/agent-monitor`.

Environment variables:

- `AGENT_MONITOR_PORT` - port (default 4747)
- `AGENT_MONITOR_HOME` - data folder (default `~/.claude/agent-monitor`)
- `AGENT_MONITOR_PROJECTS_DIR` - the only folder transcripts are read from (default `~/.claude/projects`)

## Tests

```
npm test
npm --prefix web test -- --run
```

The first runs the backend tests (temp folders, localhost only). The second runs the web tests. Files named `holdout-*` and `security-*` are the verifier's acceptance tests and the white-hat exploit tests, kept as regression tests.

## Hook it up to Claude Code

```
npm run integrate -- --dry-run
npm run integrate -- install
npm run integrate -- uninstall
```

`--dry-run` prints the plan and changes nothing. `install` changes:

- `~/.claude/settings.json`: removes the old Orca hooks and old Agent Monitor hooks, adds the Agent Monitor hooks. A backup `settings.json.bak-<timestamp>` is written first. Nothing is written if nothing changes.
- The MCP server `agent-monitor` is added with `claude mcp add --scope user`.
- `Agent Monitor.vbs` goes in the Windows Startup folder so it starts hidden at login.
- The workflow files (`skills/fable-workflow`, `skills/next`, `agents/fable-lead.md`) are copied into `~/.claude`, each old copy saved as `.bak-agent-monitor-<timestamp>`.

`uninstall` removes the hooks, the MCP server and the startup file, and restores the four files from their oldest backup (Ryan's originals).

`install` also puts the account-rotation usage recorder in front of your `statusLine` command in `settings.json` (see "Claude account rotation"). `install` also adds the `UserPromptSubmit` and `StopFailure` hooks and sets `autoContinueAtUsageLimit` to `false` in `settings.json` (uninstall removes that key when it is `false`).

## Codex fallback

When Claude's usage runs out during a tracked run, Agent Monitor hands that run to Codex (`codex exec`, the `agent-monitor-handoff` profile) and resumes it with Ryan's answers at gates. The run view, graph, runs table and Stats show Codex runs and Codex tokens apart from Claude's (no dollar figure unless a price row exists). The same `npm run integrate` sets up the Codex side, in `~/.codex` and `~/.agents`:

- `config.toml`: a marked block (`# >>> agent-monitor` ... `# <<< agent-monitor`) with `project_doc_fallback_filenames` and `project_doc_max_bytes` (Ryan's own top-level lines for those keys are commented out as `# agent-monitor-replaced: ...` and restored on uninstall), and a marked block with the `agent-monitor` MCP server.
- `agents/<role>.toml` for the six roles (models and efforts come from `src/codex-config.js`), `~/.agents/skills/<name>` links to the Claude skills, a global `AGENTS.md` with Ryan's standing rules, `hooks.json` for the Agent Monitor hooks, and the `agent-monitor-handoff.config.toml` profile (no fast tier).
- Every change is backed up as `<file>.bak-agent-monitor-<timestamp>`; `--dry-run` lists every step; `uninstall` reverses them. It never touches `auth.json`.

Gate 2 (manual, once):

1. `npm run integrate -- --dry-run`, then `npm run integrate -- install`.
2. Start `codex`, run `/hooks` and approve the Agent Monitor hooks. They need this once; nothing bypasses it. The hooks file format is unverified against Codex, so check that `/hooks` lists them.
3. Smoke test with a tiny prompt on the cheap model against a throwaway run, for example `echo "say hi" | codex exec --json -p agent-monitor-handoff -m gpt-5.6-luna -` (this is the only real Codex call; the tests use a stub).

Test overrides: `--home`, `--codex-home`, `--agents-home`, `--startup`, `--claude`, `--port`.

## Claude account rotation

When a Claude account runs out of usage, Agent Monitor tries another saved Claude account first and hands over to Codex only when every account is out. With no saved accounts, nothing changes (Codex as above). Turn it off with `AGENT_MONITOR_ACCOUNTS=off`.

Commands (`node bin/agent-monitor.js accounts ...`):

- `accounts add <name> [--current] [--email <e>]`: save a login. `--current` saves the login Claude Code is signed in with now; otherwise a sign-in runs in a temp `CLAUDE_CONFIG_DIR` (your own login is untouched).
- `accounts list`, `accounts use <name>`, `accounts remove <name>`, `accounts refresh [<name>]`.

How usage is recorded: the statusline recorder (`npm run integrate` prefixes it onto your own `statusLine` command and passes stdin through unchanged; with no statusLine it adds a quiet one), the `rate_limit_event` lines of headless runs, and limit hits. "Left" = 100 minus the higher of the 5-hour and 7-day percentages; a window whose reset has passed counts 0; an account with no reading counts as full.

State: non-secret JSON in `~/.claude/agent-monitor/accounts/` (registry and per-account usage). The logins themselves are encrypted in Windows Credential Manager as `agent-monitor/claude/*`. Saved logins are refreshed by Claude Code itself in a temp `CLAUDE_CONFIG_DIR`, so refresh tokens stay valid.

Runs vs chats:

- A tracked run that hits a limit is resumed headless on the next account with `claude --resume <session> --fork-session -p`; the switch is logged on the run timeline.
- An interactive chat gets the login switched (the current login is saved back first) and a desktop notification; type "continue" in the chat.

Gate 2 (manual, once):

1. `npm run integrate -- --dry-run`, then `npm run integrate -- install`.
2. Restart the Agent Monitor server.
3. `node bin/agent-monitor.js accounts add ryan --current`, then `accounts add orders --email orders@persist-ai.com` and `accounts add lab --email lab@persist-ai.com`.
4. `accounts list`.
5. Check by hand whether an open chat picks up a switched login (`accounts use <name>`, then send a message in the open chat).

`npm run integrate -- uninstall` removes the statusLine recorder prefix (restoring your original command exactly, or removing a statusLine that only held the recorder). Saved logins and state stay until `accounts remove <name>`.

## Wait for an answer

```
node bin/agent-monitor.js wait <run>
```

Blocks until the run is no longer waiting on Ryan, then prints one JSON line with `run`, `action`, `text`, `stage` and `status`. It retries quietly if the server is down. Set `AGENT_MONITOR_URL` to point it somewhere else.

## End-to-end check

```
npm run build
npm run e2e
```

Drives the Workflow editor, the run view and the Stats page (`editor`, `graph` and `stats` scripts, chained by `npm run e2e`) in headless Chrome against a temporary server (`playwright-core`, not part of `npm test`). Needs Chrome; set `CHROME_PATH` if it is not at the default Windows location. Screenshots go to a temp folder.

## Token usage

The server runs a usage indexer: every 5 s it reads the Claude Code transcripts under `~/.claude/projects` (read-only) into `usage.db` in the data directory. It keeps numbers, ids, model and timestamps, never message content. A message id repeats once per content block, so the indexer keeps the largest count per id. The first scan (the backfill) runs in the background and does not delay the server. When a scan adds messages, the server sends an SSE `{type:"usage"}` event.

Costs are estimates: the price table (seeded from the claude-api skill, 2026-10-06; editable) is applied to the tokens, models with no price row add 0 and are listed as unpriced.

### How tokens are attributed

Each run's tokens come from the indexer, never from the old per-agent counters. `src/attribution.js` splits them like this:

1. **Main session.** Messages from the run's main session(s) (the `main:<session>` agents) between the run's start and its end (or now) count as the run's `main` figure. They are never put on a node.
2. **Lead.** An agent whose type contains "lead", or that called `complete_stage` on two or more different nodes, is a lead. Each of its messages goes to the node visits whose time window [entered, left) contains the message time. When several visits overlap (parallel branches) the message is split evenly, with the remainder going to the first visit. A message in no window is unattributed.
3. **Any other subagent.** All its tokens go to one node: the single node it reported with `complete_stage`; otherwise, of the nodes that were active when it started, the first (in workflow order) whose runner keyword (verifier "verif", white-hat "white", reviewer "review", lead "lead"), id or name appears in its description or type; otherwise the only active worker node; otherwise the first active node; otherwise unattributed.
4. Messages from agents that are not part of the run are ignored. Total = nodes + main + unattributed.

### Endpoints

- `GET /api/runs/:id` also returns `nodes[id].tokens`, `tokens: {nodes, main, unattributed, total}` and `agents[i].tokens`. Each is `{input, output, cacheWrite, cacheRead, total, cost, unpriced}`.
- `GET /api/stats/usage?days=30|90` (default 90): `{indexer, periods: {today, week, month, avg30}, daily, unpricedModels}`. Weeks start on Monday, local time. `avg30` averages the latest 30 local days that have data and adds `days`.
- `GET /api/stats/versions`: per workflow version (newest first), finished runs, average tokens and duration, and the same per node. `GET /api/workflow/versions` adds a short `stats` to each version.
- `GET /api/prices`, `PUT /api/prices {prices: [...]}`: read or replace the price table (USD per million tokens; 400 on bad rows).

## Crew: parent link and context fill

`GET /api/runs/:id` gives every agent a `parentId` and a `context`.

- **parentId** says which agent started this one. The server reads the subagent's `meta.json` (`toolUseId`) and finds the `Agent`/`Task` call with that id in the run's activity; the agent that made the call is the parent. If there is no meta yet, at `SubagentStart` it uses the Agent/Task calls still open in the same session, but only when they all belong to one agent. The meta file is read again on later token reads and then wins over that guess. An agent is never its own parent. If nothing is known, `parentId` is `null` (the UI shows no line).
- **context** is `{tokens, window, pct}`: the agent's latest message from the usage index (input + cache write + cache read tokens; the main agent uses the latest main-session message), the model's context window (`src/context.js`; unknown models count as 200k) and `pct` capped at 100. When no message is known yet, or for Codex agents, it is `null`: unknown is hidden, never shown as 0%.
