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

`uninstall` removes the hooks, the MCP server and the startup file, and restores the four files from their newest backup.

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
