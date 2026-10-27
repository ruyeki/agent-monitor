---
name: fable-workflow
description: Ryan's default workflow for non-trivial code changes. Ryan proposes the solution first (through /next or in chat) and the spec goes into the Hephaestus task; then a lead agent (Opus in the default lite mode, Fable in full mode) plans, runs a worker and a verifier in parallel, loops fixes against the verifier (at most five rounds, stopping for Ryan on regressions), reviews and debloats, runs a white-hat security pass, commits locally, and keeps Hephaestus and Agent Monitor current. The main session presents a six-part report and opens the PR once Ryan accepts. Use it BEFORE implementing any feature, bug fix, refactor or architecture change, in lite mode unless Ryan asks for full Fable. Skip it for trivial edits (typos, copy, formatting, one setting), when Ryan says "just do it", or when he says "no Fable" / "do it yourself" (use system-aware-development then).
---

# Fable workflow

This is the default for every non-trivial code change (a feature, a bug fix, a refactor, an architecture change), in any repo. It stays on for that task and its follow-ups until Ryan says otherwise. Skip it for trivial edits (typos, copy, formatting, one setting) and when Ryan says "just do it"; when he says "no Fable" or "do it yourself", use system-aware-development instead. While it is on, it takes precedence over the system-aware-development skill: its implement, verify and teach steps are replaced by the lead's loop and the report below.

There are two modes:
- **Lite** (default): the `fable-lead` agent, spawned with the model override `opus`.
- **Full** ("full Fable", `/fable-workflow full`): the same agent with no override, so the lead runs on Fable. Use it only when Ryan asks for it.

```
/next or chat: problem card, Ryan's solution first, spec into Hephaestus     [Gate 1]
  -> lead (Fable, or Opus in lite): fact sheet, plan
  -> worker (Sonnet / Opus / Haiku)  +  verifier prep: baseline and holdout tests
  -> verifier on percy -> fix rounds (max 5); stop for Ryan on regressions or stuck loops
  -> lead review + ponytail -> white-hat pass -> local commit
  -> you: six-part report -> Ryan accepts -> push and draft PR                [Gate 2]
```

Hephaestus and Agent Monitor are kept current as `tracking.md` in this folder describes. Agent Monitor owns the stage order: after each stage, call `complete_stage` and do what it returns. The stages above are the default; Ryan can change them in its workflow editor.

## Cost discipline

Ryan's usage is limited. One early run burned 30-40% of it. The causes, and the rules that address them:

- **Repeated wake-ups were the biggest cost.** Every wake-up re-reads a whole context: the lead's, and this main session's, which is long. So the lead runs its agents in the foreground and never waits on long compute.
- **Reports were relayed through the main session.** You should not normally receive engineers' reports. If one reaches you anyway, forward a compact summary of it to the lead, not the full text.
- **Expensive models were used everywhere.** Sonnet is the default worker, verifier and white-hat; Opus is only for the hard parts; the lite mode uses an Opus lead.
- **Engineers explored and over-verified.** The lead writes one fact sheet, the verifier runs targeted tests only, and engineers propose extras instead of building them.
- **The main session added cost of its own.** Keep briefs and progress updates short. Don't poll agent status or tail transcripts.

## 1. Agree the solution with Ryan (you)

Usually `/next` has done this already: the problem card, Ryan's solution first, the spec in the task and the Agent Monitor run at `gate1`. Go on to section 2.

For a task that arrives in chat, follow steps 2–5 of the `/next` skill yourself: investigate, show the problem card, ask for Ryan's solution before yours, and write the agreed spec into the task. If it has no Hephaestus task, create one (assigned to `me`, team Nike) so the run has a record. Start the Agent Monitor run as `/next` does (`start_run`, then `complete_stage(frame)`).

**Do not spawn the lead until Ryan has agreed the approach.** A follow-up task whose approach is already settled can skip Gate 1, unless it brings a new architectural decision or real ambiguity.

## 2. Hand the task to the lead

1. **Set up the worktree.** Persist-AI-Suite work goes in a worktree under `Documents/Persist-AI` named `veritas-<ticket>`, on a branch like `fix/<ticket>-<slug>`, made from a freshly fetched `origin/main-2` unless Ryan names another base. Reuse the ticket's worktree if one exists. Record the base commit's SHA.
2. **Spawn** the `Agent` tool with `subagent_type: "fable-lead"`, in the background, so Ryan can keep talking to you. Add `model: "opus"` for the lite mode. The lead never sees this conversation, so its prompt is a brief that stands on its own, kept as short as it can be while staying precise:

```
TASK: <Hephaestus id and name; one paragraph>
RUN: <Agent Monitor run id>
WHERE: <worktree path, branch, BASE SHA, files in play>
AGREED APPROACH: <what Ryan chose, and the options he rejected>
ACCEPTANCE CRITERIA: <repeated from the task's "Agreed spec (Fable)">
EXPECTED TEST CHANGES: <or none>
OUT OF SCOPE: <...>
CONTEXT: <what the investigation found: file:line references, contracts that must stay in sync, gotchas>
UI TARGET: <URL for Playwright checks, or none>
RYAN'S DECISIONS: <anything he decided along the way>
ESCALATE TO RYAN IF: <decisions he wants back, beyond the standard stops>
```

Then tell Ryan it is running; Agent Monitor shows where it is.

## 3. While the lead works

- **`STATUS: ESCALATION` or `STATUS: BLOCKED`.** The lead has already put the task On Hold and assigned Ryan a decision task. Bring it to Ryan in plain words, with the options and the recommendation. Never decide for him. The run is now waiting on Ryan in Agent Monitor: run `node "C:/Users/ruyek/Documents/Persist-AI/agent-monitor/bin/agent-monitor.js" wait <run>` with Bash `run_in_background`, and act on its JSON line when it exits. If Ryan answers in chat instead, call `respond(run, action, text)` yourself. When he decides, set the decision task to Done and resume the lead with `SendMessage` to its agent id, passing his action and text; it keeps its full context.
- **`STATUS: AWAITING_COMPUTE`.** A long job is running. Tell Ryan what is running and roughly how long it takes. When it should be done, collect the results yourself with the lead's COLLECT WITH commands, and check them against its JUDGE BY. Resume the lead with a compact summary of the results only if its THEN line says it must review them; otherwise finish the report yourself.
- **Ryan changes something mid-run.** Relay it to the lead with `SendMessage`.
- **Don't do the work in parallel yourself.** You are the link to Ryan, not a second implementer.

## 4. Present the result (Gate 2)

Present the work only after the lead returns `STATUS: APPROVED`, or a `STATUS: BLOCKED` that Ryan needs to see.

First spot-check its main claims yourself:
- the commits it names exist (`git log`, `git show --stat`);
- the diff matches its description;
- every test result it quotes came from a run whose output it reports.

Then report to Ryan in these six parts:

1. **What was accomplished.** A short summary.
2. **How it works.** An accessible explanation, and the design decisions that matter.
3. **Code changes.** Each file created, modified or deleted, and the meaningful change in each, with commit hashes. Include the snippets or short diffs that matter, not raw dumps.
4. **Verification.** The verifier's verdicts and the tests behind them, the tests added to `tests_v2`, and the white-hat result. Say plainly what was not verified.
5. **Review iterations.** Fix rounds used (n/5), the significant issues caught, and how each was resolved.
6. **Outstanding concerns.** Limitations, deferred work, backlog items created, unresolved risks, and decisions still needing Ryan.

Keep verified behaviour, review findings and untested assumptions apart. Never claim a test passed unless it ran and passed. Never hide a known risk.

The lead's `complete_stage(report)` has already put the run at `gate2` ("Accept, push and open the PR?"). Run the `wait` command (Bash `run_in_background`) and act on its JSON line. If Ryan answers in chat instead, call `respond(run, action, text)`. `Request changes` goes back to the stage Agent Monitor names.

**When Ryan accepts,** that is his approval to push this branch, and only this branch:
1. `git push -u origin <branch>` from the worktree.
2. Open a draft PR to `main-2` with `gh pr create --draft --base main-2`: a clear title, and a body with the summary, the verification results and the outstanding concerns, ending with the attribution line.
3. Set the Hephaestus task to Done and call `complete_stage(run, pr, done, note)` with the PR link in `note`.

If he asks for changes instead, send them to the lead with `SendMessage`; his decision resets the round count.

## Agent Monitor

Load the tools once with ToolSearch: `select:mcp__agent-monitor__start_run,mcp__agent-monitor__complete_stage,mcp__agent-monitor__respond,mcp__agent-monitor__log,mcp__agent-monitor__get_run,mcp__agent-monitor__list_runs,mcp__agent-monitor__get_workflow`. Every result starts with `RUN <id> ...`, then `NEXT` (stage, runner, model, instructions) or `WAITING ON RYAN` with the actions and the wait command. When several stages are active it adds a `PARALLEL:` line and one `NEXT` pair each: run them together, in the foreground, and report each with `complete_stage`. Do what it says. If Agent Monitor is unreachable, carry on without it and tell Ryan once.

## Standing rules (Persist-AI)

These rules are also written into each agent's definition. Repeat any task-specific ones in the brief.

- **Tests run on percy, never on Ryan's Windows machine, and always in parallel.**
  - Run targeted tests with `uv run pytest <paths> -n auto`. The full `tests_v2` suite runs in CI on the PR, not in the loop.
  - Work in a fresh folder of your own on percy, never in someone's checkout.
  - Start your own Postgres container on a free port. Never use the shared `nike-pytest-pg` container, so never `scripts/pytest_postgres.sh`, which hard-codes it.
- **Tests live in `tests_v2`, never in legacy `app/tests` (Veritas, hard rule).** Never edit anything under `Backend/app/tests/`. A legacy test that must be kept or changed is moved into the right `tests_v2` layer first (git mv), then edited there; if `tests_v2` already has a ported copy, delete the legacy duplicate after checking the copy covers every test. Running legacy tests as a regression check is fine.
- **Reaching percy.** Run `python3 ~/.claude/tools/percy/ssh_run.py percy -` with the command on stdin; upload files with `sftp_put.py` beside it.
  - Both read `Credentials.txt` and mask the password.
  - Strip Windows line endings from uploaded scripts with `sed -i 's/\r$//'`.
- **Secrets.** Never print a password or secret.
- **Other people's things.** Stay read-only on other people's machines, checkouts and databases unless Ryan approved writes.
- **User data.** `formulation_kb.*` is user runtime data. Never copy it.
- **Databases.** The main database is `nike` and is read-only; Ryan's test database is `nike_test`.
- **Commits and pushes.** Engineers never commit. The lead makes a local commit for each approved, tested piece. Only the main session pushes, and only after Ryan accepts at Gate 2.
- **Merge conflicts.** Explain the conflict and the proposed resolution to Ryan, as an escalation, before resolving it.
