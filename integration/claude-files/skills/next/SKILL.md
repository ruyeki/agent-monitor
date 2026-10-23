---
name: next
description: Pick up Ryan's next Hephaestus task and frame it for him. Chooses the top To Do task assigned to him (or the one he names), investigates read-only, shows a problem card, and asks for HIS solution before offering options. Ends with an agreed spec written into the task, ready for the fable-workflow hand-off. Invoke as /next [task id | words to narrow the pick].
argument-hint: "[task id | filter words]"
disable-model-invocation: true
---

# /next: pick up and frame the next task

Pick one task, show Ryan what it really is, and get his solution before yours. Change no code. The tracking rules are in `~/.claude/skills/fable-workflow/tracking.md`; read it first.

## 1. Pick

- A number in the arguments is a task id: use it.
- Otherwise call `list_tasks` with `assignee: "me"`, `status: "To Do"`, `limit: 25`, adding `epic` when the arguments name one (for example `/next audit`). Choose the highest priority and break ties by lowest id. It returns at most 25 rows; say so when more matched.
- Tell Ryan in two lines what you picked and the next two candidates, so he can redirect with one word. Carry on unless he does.

## 2. Investigate, read-only

- `get_task` for the description and dependencies, and `whats_blocking` if it has any. If the task is blocked, say what blocks it and offer the next candidate.
- Find the code in the right repo. Persist-AI-Suite work happens in a worktree under `Documents/Persist-AI`: an existing `veritas-<ticket>` one, or a new one at hand-off. If the repo is unclear, ask.
- Read the code the task points at and cite it with file:line. Reproduce only when that is cheap and read-only; tests run on percy, never locally.
- This is framing, not solving: keep it small. Use the Explore agent only for a genuinely broad search.

## 3. Problem card

```
#<id> <task name>  (<epic>, priority <n>)
WHAT IT ASKS: <one or two lines, in plain words>
WHAT I FOUND: <evidence with file:line; what the code does today>
LIKELY CAUSE: <or "not found yet", and what you'd check next>
SIZE AND RISK: <files and contracts touched, what could regress>
OPEN QUESTIONS: <only the ones that change the work>
```

Start the Agent Monitor run now: `start_run` with `title` = the task name, `slug` = `t<id>` (or `adhoc-<slug>` with no task), `task`, `repo`. Then `complete_stage(run, frame, pass)`. The run is now at `gate1` and waiting on Ryan. If Agent Monitor is unreachable, carry on without it and tell Ryan once.

## 4. Gate 1: Ryan's solution first

Ask **"What's your solution?"** and don't show yours yet; asking first is the point. Run `node "C:/Users/ruyek/Documents/Persist-AI/agent-monitor/bin/agent-monitor.js" wait <run>` with Bash `run_in_background`, and act on its JSON line when it exits. If Ryan answers in chat instead, call `respond(run, action, text)` (`Agree spec` or `Stop run`).

- **He has one:** critique it honestly. Name its gaps, edge cases and risks with file:line, say where it beats what you'd have done, and refine it together. Don't just agree.
- **He says "options", or has none:** give two or three approaches with their trade-offs, complexity and risk, and recommend one.
- **He says it's trivial, or "just do it":** skip the Fable hand-off and do it directly, as the global rules allow.

## 5. Agree the spec

When Ryan agrees, write the spec into the task (tracking.md, Hephaestus, Spec):
- the approach, and the options he rejected;
- numbered, testable acceptance criteria;
- expected test changes: existing tests that are meant to change, which the verifier won't count as regressions;
- what is out of scope;
- repo, worktree and branch.

Then continue with the fable-workflow skill, section 2, and put `RUN: <id>` in the brief to the lead. Ryan's agreement at Gate 1 is the approval it needs.
