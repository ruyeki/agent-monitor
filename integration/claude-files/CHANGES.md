# Proposed changes to Ryan's workflow files

Base: the files in `~/.claude` on 2026-10-23. Everything else in them is unchanged. The installer (`npm run integrate`) backs up the originals before copying these over.

## skills/fable-workflow/SKILL.md
- Frontmatter and text: the old radar view is replaced by "Agent Monitor".
- Diagram note: the stage order lives in Agent Monitor; after each stage call `complete_stage` and do what it returns.
- Brief to the lead: `RADAR VERSION` becomes `RUN: <Agent Monitor run id>`.
- Mid-run stops: the main session runs `agent-monitor.js wait <run>` in the background, or calls `respond` if Ryan answers in chat.
- Gate 2: the lead's `complete_stage(report)` already puts the run at gate2. Main session waits, pushes, opens the PR, then `complete_stage(pr, done)`.
- New short section "Agent Monitor": load the MCP tools, how to read a result, carry on if it is down.

## skills/fable-workflow/tracking.md
- The Radar sections (stage table, record format, timestamps, versions, board snapshot) are replaced by one "Agent Monitor" section. The engine keeps history, rounds and timestamps now.
- Outcomes listed: pass, done, fail, finding, regression, env, stuck. The lead reports what happened; Agent Monitor counts rounds and turns limits into a decision.
- The tool-load line now lists the Agent Monitor tools instead of `ArtifactData`.
- The Hephaestus section is unchanged.

## skills/next/SKILL.md
- Board snapshot refresh removed (no board in Agent Monitor).
- At the problem card: `start_run` (title = task name, slug `t<id>` or `adhoc-<slug>`, task, repo), then `complete_stage(frame)`.
- At Gate 1: run `wait` in the background; `respond` if Ryan answers in chat.
- The hand-off brief carries `RUN: <id>`.

## agents/fable-lead.md
- Frontmatter and text: the old radar view is replaced by "Agent Monitor".
- Every "write the radar stage X" becomes `complete_stage(run, X, outcome)`, and the lead does what it returns.
- Fix rounds: the lead reports fail/finding; Agent Monitor counts rounds and returns the `fix` stage. The loop rules (five rounds, same failure twice, regression stops) stay in the text as the lead's own check.
- Stops: the lead reports the outcome with the question as the note, then returns `STATUS: ESCALATION`.
- Reports end with `RUN: <id>` instead of `RADAR VERSION`.
- Role descriptions, cost discipline, briefs, report formats and standing rules are unchanged.
