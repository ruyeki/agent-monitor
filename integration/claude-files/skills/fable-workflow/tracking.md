# Tracking a Fable run

Two places show where a task is. The main session and the lead write to them; nobody else does.

- **Hephaestus** is the record of the task: its spec, status, decisions and agent log.
- **Agent Monitor** (http://127.0.0.1:4747) is Ryan's live view of every run: stage, round, agents and what they are doing. It also holds the stage order and the gates.

Load the tools once with ToolSearch: `select:mcp__agent-monitor__start_run,mcp__agent-monitor__complete_stage,mcp__agent-monitor__respond,mcp__agent-monitor__log,mcp__agent-monitor__get_run,mcp__agent-monitor__list_runs,mcp__agent-monitor__get_workflow,mcp__hephaestus__get_task,mcp__hephaestus__update_task,mcp__hephaestus__create_task,mcp__hephaestus__add_dependency,mcp__hephaestus__add_backlog_item`.

Write only at the moments listed below, and only to the task in play, its decision tasks and the backlog. Ryan is a Super Admin, so these tools could edit anyone's task.

## Agent Monitor

One run per task. The run id is `t<task id>` (for example `t980`), or `adhoc-<slug>` when there is no task.

- The main session calls `start_run` (title = task name, slug, task, repo) when /next starts framing, then `complete_stage(run, frame, pass)`. The run is then at `gate1`.
- After each stage, call `complete_stage(run, <stage>, <outcome>, note)` and do what it returns. Agent Monitor knows the stage order. Don't keep your own list.
- Outcomes: `pass`, `done`, `fail`, `finding`, `regression`, `env`, `stuck`. Report what happened. Agent Monitor counts the fix rounds and turns the round limit, a regression, an env problem or a stuck loop into a decision for Ryan.
- Every result starts `RUN <id> ...`. Then it gives either `NEXT` (stage, runner, model, instructions) or `WAITING ON RYAN`, with the actions and a `wait` command.
- At every gate or decision, run the `wait` command with Bash `run_in_background`. It exits with one JSON line: `{"run","action","text","stage","status"}`. Act on it. If Ryan answers in chat instead, call `respond(run, action, text)`.
- Use `log(run, note)` for a side note that is not a stage change. `get_run` and `list_runs` are for checking where things are.
- Only the main session calls `respond`. The lead calls `complete_stage` for the stages it runs (plan to report) and returns to the main session when the run waits.
- If Agent Monitor is unreachable, carry on without it and tell Ryan once.

## Hephaestus

- **Spec (main session, after Gate 1).** `get_task`, then `update_task` with the existing description plus a section `## Agreed spec (Fable)`: the approach and the options rejected, numbered testable acceptance criteria, expected test changes, out of scope, repo and branch. The verifier reads the acceptance criteria from here.
- **Status.** The lead sets `In Progress` when it starts and when it resumes, and `On Hold` on every stop. The main session sets `Done` only after Ryan accepts and the PR is open. Valid statuses: Planned, To Do, In Progress, On Hold, Done.
- **Agent log (lead).** One line per verification result under `## Agent log` in the description, for example `2026-10-21 23:41 UTC verify 2/5 FAIL: double-encoded traversal accepted`. `update_task` replaces the whole description, so re-read it before each write.
- **Stops (lead).** Create a task named `Decision needed: <task name>`, assigned to `me`, priority 4, same team and epic, whose description is the stop report (why, options, recommendation). Then `add_dependency(task_id=<task>, depends_on_task_id=<decision task>)` so the sprint view shows the block. The main session sets the decision task to Done once Ryan decides.
- **Side findings.** Failures that also fail on the base commit, flaky tests, security issues in code the diff didn't touch, and engineers' proposed additions go to `add_backlog_item` (same team; priority 4 for security issues), never into the current task.
