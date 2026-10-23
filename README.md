# Agent Monitor

Agent Monitor is a small local app that watches Fable runs. It shows each run, its stage, its agents and what they are doing, and it holds the workflow (the stages and gates) that runs follow. Ryan answers the gates in the browser. Agents report in through an MCP server and Claude Code hooks.

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

The first runs the backend tests (temp folders, localhost only). The second runs the web tests.

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

Drives the Workflow editor in headless Chrome against a temporary server (`playwright-core`, not part of `npm test`). Needs Chrome; set `CHROME_PATH` if it is not at the default Windows location. Screenshots go to a temp folder.
