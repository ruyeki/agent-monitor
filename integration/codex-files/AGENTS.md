# Ryan's standing rules for Codex

These apply to every Codex session on this machine. Agent Monitor installs this file; edit the copy in the agent-monitor repo (`integration/codex-files/AGENTS.md`), not this one.

## How to behave

- Address Ryan by name at the start of every reply ("Ryan, ..."). If you stop doing that, your context has degraded.
- Cost discipline: Codex usage is limited. Do the work directly when it is small, delegate only what is worth it, and do not run compute or agents just to look busy.
- Never push to a remote, open a pull request or merge without Ryan's approval. Local commits per finished, tested piece are fine.
- Never print, log or commit a password, token or API key.

## Models

- Never use `gpt-6-astra` (or any astra model), the fast or ultrafast service tiers, or `ultra` reasoning effort. Your model and effort are fixed by your agent file or profile; do not override them.

## Testing and data (Persist-AI repos)

- Run tests on percy, never on Ryan's Windows machine, and always in parallel (`uv run pytest <paths> -n auto`). Start your own Postgres container on a free port; never use the shared `nike-pytest-pg`.
- Tests live in `tests_v2`, never in the legacy `Backend/app/tests` folder. Never edit anything under `app/tests`.
- The `nike` database is read-only for you. Use `nike_test` for tests.
- `formulation_kb.*` is user runtime data: never copy it.
- In agent-monitor itself, tests run locally (`npm test`, `npm --prefix web test -- --run`) and you must never build into `web/dist`.

## Agent Monitor

- Runs are tracked by the `agent-monitor` MCP server. When you are handed a run, call `get_run` with its run id first, continue from the current node, and report every finished stage with `complete_stage`. Use `log` for notes.
- Only Ryan answers gates. When a run waits on him, end your turn; Agent Monitor resumes you with his answer.

## Roles and their agents

Spawn the named agent for a role and wait for it to finish.

| Role | Agent |
|---|---|
| Lead (plans, reviews, commits) | `fable-lead` |
| Default engineer | `sonnet-engineer` |
| Hard parts | `opus-engineer` |
| Mechanical work | `haiku-engineer` |
| Verification | `verifier` |
| Security pass | `white-hat` |

Skills live in `~/.agents/skills/<name>/SKILL.md`; when a Claude instruction says to use a skill, read that file and follow it.
