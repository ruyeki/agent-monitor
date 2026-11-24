# Impeccable critique: Agent Monitor web app ("before", 2026-11-23)

Method: dual-agent (A: design review of the worktree `C:/wt/am-crew-ledger` by the critique engineer, scored and written before the detector JSON was opened · B: deterministic harness `harness/run.py before`: `impeccable detect` 4.10.0 on `web/src` and on 6 served URLs, plus 52 Playwright screenshots with overflow and console checks).
Note on independence: A and B were not two LLM sub-agents. B has no model in it (detector rules and a scripted browser); A only read B's screenshots, and read the detector JSON after A's scores were fixed.

Target: every page of the web app (`web/src`), as it is in the worktree now. That includes the in-flight, uncommitted piece 1/2 edits to `run/CrewTab.jsx`, `lib/crew.js` and `styles.css`.
Evidence: `C:/Users/ruyek/.claude/fable-runs/am-crew-ledger/shots/before/`. That is 13 pages x light/dark x 1440/390 (`shots/*.png`), `shots/shots.json` and `detect/*.json`. The seeded data is one running run with 14 agents (`crew-ledger-demo`), one run waiting at Gate 1 (`inbox-needs-you`), 3 finished runs and 30 days of usage.

---

## Design Health Score (Nielsen, Assessment A)

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | Live dot, spinners, "Updated just now" and the current call per agent are good. But an unknown cost shows as "$0.00", running agents read "idle 14s" in the Stages rail, and a stale sidebar view looks selected on other pages. |
| 2 | Match System / Real World | 3 | Plain words in most places ("Needs you", "What this run changed", "Can't be undone"). Raw ids leak in: timeline "answer gate1", the editor's edge list "split -*→ prep", raw model ids, the "Machines" filter. |
| 3 | User Control and Freedom | 2 | The header's Stop run asks to confirm. A gate answer, including the "Stop run" answer, is one click and cannot be undone: it confirms for 1.1 s and folds away. The same goes for the Fleet card's quick answers. |
| 4 | Consistency and Standards | 2 | Two different "Now" cards and two different "Totals" cards on the Crew and Stages tabs. The lead is called "reviewer" on its card but "fable-lead" in the tool calls. "Finished" means 3 runs on Monitor but 1 on Stats. Glyph icons in the graph, SVG icons everywhere else. |
| 5 | Error Prevention | 2 | The answer that ends the run sits next to the primary button with the same weight and no confirm. Fleet answers go out with an empty reply and only the question's first line visible. |
| 6 | Recognition Rather Than Recall | 3 | Nav icons have labels, counts are visible, there are breadcrumbs. But five agents are named "sonnet-engineer", all with an "E" avatar, and the tool-call rail cuts names to "sonnet-en…". Mapping a call to its agent needs memory. |
| 7 | Flexibility and Efficiency | 3 | Ctrl K search, Views, the remembered List/Fleet layout, Ledger filters, Fleet quick answers. There is no key to jump to or send the next answer, and the run tabs ignore arrow keys. |
| 8 | Aesthetic and Minimalist Design | 3 | Calm, restrained and well spaced. Noise sits at the edges: the "Needs you" count shows four times on Monitor, the Crew "Now" card repeats the tree, finished rows say "Stopped" twice, and an empty donut has a 12-row legend of zeros. |
| 9 | Error Recovery | 2 | Errors are shown inline with `role="alert"`, and the last good data and the reply text are kept (good). But the message is the raw `e.message` and gives no next step ("Could not load run X: HTTP 500"). |
| 10 | Help and Documentation | 2 | Good one-line hints in context (crew hint, inbox note, Ledger footnote, cost-estimate notes). There is no help or legend for roles and avatars, and no link to docs. |
| **Total** | | **25/40** | **Acceptable** |

## Audit scores (technical, /20)

| # | Dimension | Score | Key finding |
|---|-----------|-------|-------------|
| 1 | Accessibility | 3 | Status is never shown by colour alone (`StatusIcon` has `role="img"` and a label), `:focus-visible` rings are everywhere, the inbox heading is a live region, and reduced motion is handled on purpose. Gaps: the run tabs are `role="tab"` links with no arrow-key support, there is a long tail of 10–11.5px text, and graph text renders at about 9px. |
| 2 | Performance | 3 | Nothing heavy: animations use transform, the live stream is debounced and the clock is shared. Minor: `.acct-bar b` animates `width`, and the Crew tab runs about 25 infinite animations at once. |
| 3 | Theming | 3 | A full token system, with a dark theme designed for dark rather than inverted. The vendored affectUI pieces are mapped to app tokens in `affectui-theme.css`, so they follow the theme switch. The avatar colours `.av-*` (`#5a5a62`, `#6b4fd1`, `#2f6fdc`, …, `color:#fff`) are hard-coded hex and the same in both themes. |
| 4 | Responsive Design | 2 | At 390px the workflow editor's canvas is 0px wide and the settings panel is clipped (hidden by `main.full { overflow:hidden }`, so the harness reports overflow 0). The Stages graph clips nodes and traps touch scrolling. There is one breakpoint (768px) and nothing for mid widths. |
| 5 | Implementation Integrity | 2 | The system is coherent, but there are several verified drifts: the lead is mislabelled, unknown cost renders as $0.00, there are two designs for Now and for Totals, glyph icons, a side-stripe card, the hard-coded name "Ryan", and a sidebar with two items selected. |
| **Total** | | **13/20** | **Acceptable** |

## Design Specificity Verdict

**LLM assessment.** The shell could belong to any SaaS dashboard: a 232px grey sidebar with search and Ctrl K, a row of four KPI tiles, white 10px cards with a hairline-plus-soft shadow, Inter, and tinted status pills. The affectUI look explains that and is the agreed identity, so it is not held against the app. The product-specific parts are strong and could not be moved to another product unchanged:
- the decision inbox (one card per waiting question, reply box, gate actions);
- the Crew tree with real parent connectors, the current call per agent and a context bar;
- the Ledger with reversibility tags and a "Can't be undone" summary;
- the stage stepper on Fleet cards.

The missed chance is on Monitor. The most product-specific thing, "a question is waiting for you", sits below a generic KPI strip that repeats its count.

**Deterministic scan.** 4 source findings, all warnings or advisories:
- `overused-font` (Inter) in `web/src/fonts.css:4`;
- `gradient-text` ×2 on the vendored shimmer overlays in `vendor/affectui/thinking-loader.css:139` and `tool-call-card.css:403`;
- `bounce-easing` in `vendor/affectui/tool-call-card.css:152`.

The URL scans returned `[]` (exit 0) for 6 URLs: Monitor, Crew at 1440 and at 390x844, Ledger, Stats and Workflow. That is not "clean". The JSON has no element or page counts, so this run cannot prove the SPA had rendered when the engine read the page. Stages, Fleet, Accounts and the three views were not URL-scanned. The detector missed the side-stripe on `.waiting-card` (that card only renders for a waiting run, which no scanned URL showed). Both `gradient-text` hits are false positives (see the table at the end).

**Visual overlays.** None. This was a headless harness run on percy with no live-server injection, so there is no `[Human]` overlay tab.

## Overall impression

This is a calm, well-built operator console. Tokens, dark mode, status icons and reduced motion are handled more carefully than in most dashboards, and the Ledger tab is close to excellent. The weak points cluster around the two jobs that matter most. **Answering**: the run-ending answer is one click with no undo, and it sits under a KPI strip. **Watching the crew**: agents can't be told apart, the lead is labelled "reviewer", and finished agents carry the same weight as running ones. The biggest opportunity is to make agent identity unambiguous everywhere (tree, Now, tool calls, filter) and to guard the answers that end a run. Both fit inside the current look.

## What's working

1. **Status never relies on colour alone, and motion is opt-out on purpose.** `StatusIcon` (`RunList.jsx`) pairs an icon shape with an accessible name, every pill carries text, and the legend dots have labels. Under `prefers-reduced-motion` the spinning `.ring` becomes a full, still ring (`styles.css` l.580) rather than being killed outright, and the Stats intro animations only run under `no-preference`.
2. **Dark mode is designed for dark, not inverted.** It has its own token set, with tints flattened onto `--surface` so pills keep contrast. The vendored affectUI pieces are re-pointed at app tokens in `affectui-theme.css` with `:root`-scoped selectors, so light, dark and system all follow one source. In the screenshots both themes read with the same hierarchy.
3. **The Ledger tab speaks plainly and is honest.** Each change is one row ("Pushed feat/am-crew-ledger to GitHub", with chips for repo and sha range), a reversibility tag, a "Can't be undone" summary, and a footnote saying exactly what is and isn't stored. It holds up at 390px without changes.

## Priority issues

### [P1] gate-answer-ends-run-unguarded: a gate answer that ends the run is one click, with no confirm and no undo
- **What:** In the Monitor decision inbox, Gate 1 shows "Agree spec" (primary) and "Stop run" side by side (`monitor-light-1440.png`). Clicking "Stop run" sends at once: `Monitor.jsx` `Inbox.decide` (l.136) calls `respond()`, the card confirms for 1.1 s and then folds away. The Fleet card's `QuickAnswers` (`Fleet.jsx` l.16–37) does the same, with an empty reply and only the question's first line visible. Yet the header's Stop run (`StopButton.jsx`) asks "Stop run X? Confirm / Cancel".
- **Why:** This is the highest-stakes click in the app. It ends a run (the edges go `gate1 -Stop run→ stopped` and `gate2 -Stop run→ stopped`), it sits next to the primary button with the same weight, and it cannot be taken back. The same action is guarded in one place and not in another.
- **Fix:**
  1. Mark actions that lead to an End node. The server sends only `{label}` today (`src/store.js` l.209), so either add `ends: true` there, or fall back to a label match (`/^(stop|reject|cancel)/i`). This needs a lead decision.
  2. In `Monitor.jsx` `Inbox.decide`, and in `Fleet.jsx` `QuickAnswers.answer`, turn the first click on an ending action into the `confirm-inline` pattern from `StopButton.jsx` ("Stop this run? Confirm / Cancel"), and give it `className="danger"`.
  3. In Fleet, show quick answers only when `!run.textField`. Otherwise show "Answer…" linking to the inbox card.
- **Suggested command:** harden

### [P1] lead-shown-as-reviewer: the fable-lead is labelled "reviewer" (grey "R" avatar) on the Crew tree and in Now
- **What:** `lib/crew.js` `roleOf()` checks the description words (`DESC_ROLES`, l.7–12) before the type (`TYPE_ROLES`). The lead's description "Plans, delegates and reviews the crew-ledger work" matches `/\breview/`, so a `fable-lead` becomes "reviewer" with avatar R/grey. The tool-call rail, which uses the raw type, says "fable-lead" for the same agent (`run-crew-light-1440.png`: tree "reviewer Opus 5.5" vs rail "Edit web/src/run/Cre… fable-lead").
- **Why:** The person in charge of the run is misnamed, and the same agent has two names on one screen. A user watching the crew can't find the lead.
- **Fix:** In `roleOf()`, return the type's role first when the type already names a specific role (`/lead|verif|white|review/` on `agent.type`). Use description words only for generic types (`*-engineer`, `general-purpose`, `worker`). Add a case to the `lib/crew.js` unit tests: `{type:'fable-lead', description:'Plans … reviews …'}` → `lead`. Note that `lib/crew.js` has in-flight piece 2 edits; coordinate.
- **Suggested command:** clarify

### [P1] agents-indistinguishable: five agents share one name and avatar, and the tool-call rail cuts the name off
- **What:** The Crew tree shows "sonnet-engineer" five times, each with the same blue "E" avatar. In the Tool calls rail the agent column is `.ui-tclc__agent { max-width: 30%; font-size: 11px }` (`vendor/affectui/tool-call-card.css` l.475, an Agent Monitor addition), which shows "sonnet-en…", "general-p…", "opus-engi…". After selecting an agent, the filter button reads "Clear filter (sonnet-engineer)", which matches five agents.
- **Why:** Watching a running crew means mapping each tool call to its agent. Today the only way to do that is to remember which engineer had which task.
- **Fix:**
  1. Add `agentLabel(agent, crew)` to `lib/crew.js`. It returns `agentName` plus an ordinal when the name repeats ("engineer 2"), or a short task tag from the first words of `description`.
  2. Use it in `CrewTab.jsx` `AgentCard`, `NowCard` and the "Clear filter (…)" button, in the `agent` prop passed by `ToolCallList` (`run/RunSide.jsx`), and in Fleet `CrewStrip`.
  3. In `affectui-theme.css` add `:root .run-side .ui-tclc__agent { max-width: 40%; font-size: 12px; }`.
  4. When a filter is active, hide the now-redundant agent column (`.run-side[data-filtered] .ui-tclc__agent { display:none }`).
- **Suggested command:** clarify

### [P2] workflow-editor-phone-broken: at 390px the editor canvas is 0px wide and the settings panel is clipped
- **What:** `.editor-body { grid-template-columns: 220px minmax(0, 1fr) 340px }` (`styles.css` l.425) has no narrow-screen rule. At 390 the palette takes the column, the canvas collapses to nothing, and the settings panel is cut at the right edge (`workflow-light-390.png`). `main.full { height:100vh; overflow:hidden }` (l.599) hides the overflow, so `shots.json` reports `overflow: 0`.
- **Why:** The page can't be used on a phone. Editing workflows on a phone is unlikely, so this is P2 rather than P1, but the page should at least degrade cleanly.
- **Fix:** In the `@media (max-width: 768px)` block add `.editor-body { display:flex; flex-direction:column; } .canvas-wrap { height: 60vh; flex:none; } .settings, .palette { overflow: visible; }`, and let `main.full` scroll when it holds `.editor` (`main.full:has(.editor) { height:auto; overflow:visible; }`). Alternatively, show "Open the editor on a wider screen" under 768px.
- **Suggested command:** adapt

### [P2] stages-graph-framing: the Stages graph cuts off the workflow, overlaps edge labels and shrinks node text to about 9px
- **What:**
  - `FIT_VIEW = { padding: 0.1, minZoom: 0.75 }` (`editor/Canvas.jsx` l.11) is used by `RunGraph.jsx` l.43–48. The 19-node workflow can't fit at 0.75, so the start of the workflow (Frame, Gate 1, Plan) sits above the top edge, and in the editor nodes are cut on the left (`run-stages-light-1440.png`, `workflow-light-1440.png`).
  - Edge labels collide: "Request changes" and "Stop run" at Verify, "regression / env / stuck".
  - Node text (`.fnode-sub`, badges) renders at about 9px.
  - At 390, Decision and Fix are cut on the right and the zoom Controls cover "Gate 2: accept". The 60vh pane (`styles.css` l.613) takes over touch drags, so the page won't scroll past it.
- **Why:** The Stages tab is how a user answers "where is this run?", and it opens without framing the running or waiting stage.
- **Fix:**
  1. In `RunGraph.jsx`, fit to the active nodes: `fitViewOptions={{ nodes: activeIds.map(id => ({ id })), padding: 0.5, maxZoom: 1 }}`, with `activeIds` from `runState(detail)` (running or waiting). Keep the Controls' fit-all at `minZoom: 0.3`.
  2. Hide the per-node "Stop run" edges by default, since every gate has one, behind a legend toggle "Show stop edges".
  3. At ≤768, pass `panOnDrag={false} preventScrolling={false}` so the page scrolls, and move Controls to `position="top-right"`.
- **Suggested command:** layout

### [P2] inbox-below-kpis: on Monitor the question that needs you sits under four KPI tiles
- **What:** `Monitor.jsx` renders `.stat-strip` (l.287) before `.monitor-body`/`.inbox-pane` (l.294–296). At 390 the brand, search, 4 nav links, 3 views and the theme row take about 230px, and the tiles take two more rows. The question card starts at about y=540 (`monitor-light-390.png`).
- **Why:** The one thing on Monitor that needs the user is pushed below summary numbers, one of which ("Needs you 1") just repeats the inbox heading.
- **Fix:** In `Monitor.jsx`, when `waiting.length > 0`, render the `inbox-pane` before the `stat-strip`. At ≤768 also hide `.nav-head` and the Views row (`.side-nav.views`), since Monitor's own tiles and headings already show those counts.
- **Suggested command:** layout

### [P2] sidebar-two-selected: a Views filter stays highlighted on other pages, so two sidebar items look current
- **What:** `Sidebar.jsx` l.83 sets `aria-pressed={view === id}` whatever the route. After choosing "Running", the Stats, Accounts, Workflow and run pages all show "Running" highlighted next to their own nav item (`stats-light-1440.png`, `accounts-dark-1440.png`).
- **Why:** The sidebar contradicts itself about where the user is, and the filter quietly carries over when they go back.
- **Fix:** Pass `routeName` into `Sidebar` and use `aria-pressed={routeName === 'monitor' && view === id}`, or clear `view` in `App.jsx` when the route leaves `monitor`.
- **Suggested command:** polish

### [P2] unknown-cost-shows-zero: a cost that isn't known yet reads "$0.00"
- **What:** `formatCost()` (`lib/format.js` l.51) maps `undefined` to `$0.00`. The seeded run's agents have hundreds of thousands of tokens on record, but every card, the header, the Crew head, the run row and Totals read "$0.00", and Totals says "Tokens 0". Monitor meanwhile says "Spend today $4.22".
- **Why:** "$0.00" says "free". It is misleading data on the screen that answers "what is this costing me?".
- **Fix:** In `formatCost`, return `'–'` when `n == null` (keep `$0.00` for a real 0). Callers already pass `a.tokens?.cost`. Show "not priced yet" in the Totals card when `detail.tokens.total.total` is 0 but `agents` report tokens. Update the `format.js` tests.
- **Suggested command:** clarify

### [P2] crew-equal-weight: finished agents look like running ones, and "Now" repeats the tree
- **What:** On the Crew tab all 14 `.card.ag` look the same except for the pill (6 are Done). The rail's `NowCard` (`CrewTab.jsx` l.90, l.210) lists the same 8 running agents and their calls again, 6 of them with a shimmering `ThinkingLoader`.
- **Why:** To watch the crew, the user scans 14 equal cards for 8 blue pills. The Now card doubles the reading without adding facts.
- **Fix:** In `styles.css`, quiet finished cards: `.ag:has(.pill.done) { box-shadow: inset 0 0 0 1px var(--border); background: transparent; } .ag:has(.pill.done) .agtask { color: var(--muted); }` (or set `data-status` on the `article`). In `CrewTab.jsx`, replace `NowCard` with a one-line summary in the Crew card head ("8 running · 1 waiting for permission"), or keep it only on Stages.
- **Suggested command:** distill

### [P2] now-totals-two-designs: the same card names show different content on Crew and Stages
- **What:** "Now" on Crew shows avatar, name, mono call and loader. On Stages (`RunSide.jsx` `ActiveAgents`) it shows name, description, the raw model id "claude-opus-5-5-20261001 · idle 14s", last tool and loader. "Totals" on Crew is a big-figure grid (`CrewTab.jsx` `Totals`); on Stages it is inline prose (`RunSide.jsx` l.~120). Running agents read "idle 14s".
- **Why:** Switching tabs changes how the same facts look and what they're called. "idle" on a running agent reads like a stall.
- **Fix:** Use one `NowCard` and one `Totals` in `run/RunSide.jsx`, imported by both tabs. Use `modelLabel()` for the model everywhere. Show `idle Xs` only when it is over 60 s, worded "no activity for 2m".
- **Suggested command:** polish

### [P2] status-glossary-drift: "Finished", "Stopped" and "Open" mean different things on different pages
- **What:**
  - Monitor "Finished 3" means done plus stopped. Stats Runs (`stats/RunsPanel.jsx` l.13–15) shows "Finished 1 · Stopped 2 · Open 2".
  - "Open" appears nowhere else; Monitor says Running and Needs you.
  - A stopped run gets a red ⊗ (`.si-stopped { color: var(--danger) }`) and a grey "Stopped" pill. Stats colours Stopped `var(--danger)`.
- **Why:** The same word counts different sets, and a stop the user asked for is drawn as a failure.
- **Fix:** One glossary: Done, Stopped, Running, Needs you. Rename RunsPanel's labels to `['finished','Done']`, `['open','Running or waiting']`. Set `.si-stopped` and the Stats stopped colour to `var(--run-idle)`, and keep red for real failures.
- **Suggested command:** clarify

### [P2] phone-agent-select-offscreen: on a phone, selecting an agent changes a list about 2,000px further down
- **What:** At ≤768, `.run-body` stacks the rail under the tree (`styles.css` l.612). On `run-crew-light-390.png` the Tool calls card starts about 2,800px down, roughly 2,000px below the first engineer's card. Tapping an agent only adds the card ring in view.
- **Why:** On a phone there is no visible result of the action, so it looks broken.
- **Fix:** In `CrewTab.jsx` `onSelect`, when `matchMedia('(max-width: 768px)').matches`, scroll `section[aria-label="Tool calls"]` into view (`block:'start'`), or render the selected agent's last 3 calls inline under its card at narrow widths.
- **Suggested command:** adapt

### [P3] waiting-card-side-stripe: the waiting card uses a one-sided coloured bar
- **What:** `.waiting-card { border-left: 3px solid var(--warn) }` (`styles.css` l.389) on a 10px-radius `.card`. It shows in the Crew and Stages rails when the run is waiting. This is on the refuse list (side-tab border).
- **Fix:** Replace it with a full tint and ring: `.waiting-card { border-left: 0; background: color-mix(in srgb, var(--warn-bg) 60%, var(--surface)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--warn) 35%, transparent), var(--elev-1); }`, and put `<ClockIcon/>` before the `h3` in `WaitingCards.jsx`.
- **Suggested command:** polish

### [P3] glyph-icons: the run graph and the Finished disclosure use Unicode glyphs as icons
- **What:** `RunGraph.jsx` `LEGEND` (l.8–14) uses ✓ ✕ ⏸ ▶ –, node status in `run/runState.js` l.8 uses "⏸ waiting on Ryan" and "▶ running", and `.finished > summary .group-head::after` uses ▸/▾ (`styles.css` l.210–211). Everywhere else the app draws SVG icons (`StatusIcon`, Sidebar, Ledger).
- **Fix:** Reuse `StatusIcon` (12px) in the legend and node status. Replace the `::after` glyph with an inline chevron SVG in `Monitor.jsx` `Group`, rotated by `[open]`.
- **Suggested command:** polish

### [P3] hardcoded-name: the product names one user
- **What:** "Waiting on Ryan" (`RunGraph.jsx` l.11), "⏸ waiting on Ryan" (`run/runState.js` l.8), "Waits for Ryan's answer" (`editor/Palette.jsx` l.9).
- **Fix:** Say "Waiting on you" and "Waits for your answer", the wording Monitor already uses ("Needs you").
- **Suggested command:** clarify

### [P3] run-tabs-no-arrow-keys: the run tabs claim the ARIA tab pattern but ignore arrow keys
- **What:** `RunHeader.jsx` l.62–64 renders `<a role="tab">` with no roving `tabIndex` and no ArrowLeft/ArrowRight/Home/End handling. A screen reader says "tab, 1 of 3", but the arrow keys do nothing.
- **Fix:** Add `tabIndex={tab === id ? 0 : -1}`, and an `onKeyDown` on the tablist that moves focus and sets `location.hash = runHref(run.id, next)`. Keep the ids, roles and `#panel-*` (the harness and tests rely on them).
- **Suggested command:** harden

### [P3] nested-cards: cards inside cards on the Crew tab and in the rails
- **What:** The agent cards (`.card.ag`) sit inside the Crew card (`.card.crew-main`), and the vendored tool-call cards (`.ui-tclc`) sit inside the "Tool calls" `.card.side-card`. Nested cards are on the refuse list.
- **Fix:** Drop the chrome on the outer containers. Use `.crew-main { background: none; box-shadow: none; }` with the `cardhead` kept as a plain header row. In `affectui-theme.css`, flatten the rail list with `:root .run-side .tool-calls .ui-tclc { box-shadow: none; border-radius: 0; border-top: 1px solid var(--border); }`.
- **Suggested command:** distill

### [P3] small-text-tail: much status information is set at 10–11.5px
- **What:**
  - `.chip, .stage-pill` 11.5px (`styles.css` l.115), and `.badge` and `.tag` 11.5px;
  - `.group-count`, `.nav-head` and `kbd` 11px; `.ctx` 11.5px; `.av` 10.5px and `.av-more` 10px;
  - in the vendor CSS, `.ui-tclc__agent` 11px and `.ui-tclc__label` 10px uppercase;
  - graph node text at about 9px after the 0.75 zoom.

  A 13px body is justified for a dense operator console. Chips that carry stage and status should not go below 12px.
- **Fix:** Set `.chip, .stage-pill, .badge, .tag, .ctx` to 12px, and `.group-count` to 12px. In `affectui-theme.css` add `:root .ui-tclc__agent { font-size: 12px }`.
- **Suggested command:** typeset

### [P3] flat-heading-scale: section headings are body-sized and set apart only by weight
- **What:** h1 is 19px (18px on run pages). Card heads `.cardhead h2/h3` are 13px/600, the same size as body text. `.group-head` is 12px muted.
- **Fix:** Set `.cardhead h2, .cardhead h3` to 14px; `.group-head` to 13px `var(--text-2)`; and h1 to 20px with `letter-spacing: -0.015em`. Inter and the weights stay the same.
- **Suggested command:** typeset

### [P3] needs-you-count-x4: the waiting count shows four times on Monitor
- **What:** It appears as the sidebar "Needs you 1", inside the Monitor nav count, as the KPI tile "Needs you 1 · oldest 5s ago", and as the inbox heading "1 needs your input". The KPI strip is the hero-metric template.
- **Fix:** In `Monitor.jsx`, drop the "Needs you" `Stat` when the inbox is shown, and move "oldest 5s ago" next to the inbox heading via `.inbox-note`.
- **Suggested command:** distill

### [P3] motion-scatter: about 30 looping animations run at once on the Crew tab
- **What:** Six running agents have a `.ring` in their current-call row, and all 8 running agents have another inside their `.pill.run` (`RunBits.jsx` l.84). There are 6 `ThinkingLoader` spinners and shimmers in Now, plus 3 running tool-call spinners and shimmers. The vendored `.ui-tclc__ok` pops with an overshoot curve `cubic-bezier(0.34, 1.56, 0.64, 1)` (detector `bounce-easing`).
- **Fix:** Drop the ring in `AgentPill`'s running pill; the call row already shows activity. Override in `affectui-theme.css`: `:root .ui-tclc__ok { animation-timing-function: cubic-bezier(0.16, 1, 0.3, 1); }`. With crew-equal-weight fixed, the Now loaders go away too.
- **Suggested command:** quieter

### [P3] finished-rows-repeat-status: finished rows say "Stopped" or "Done" twice, plus "round 0/5"
- **What:** `RunList.jsx` `RowBody` renders `stage-pill` (l.61) holding the status-like stage label and an end pill with the same word. It also shows "round 0/5" for runs that never looped. In the Finished view, the group is still a collapsible `<details>` that can fold away the page's only content.
- **Fix:** For ended runs, hide `.stage-pill` when `stageLabel(run)` equals the status, and hide `.run-rounds` when `run.round === 0`. In `Monitor.jsx` `Group`, render a plain header (not `details`) when `view === 'finished'`.
- **Suggested command:** distill

### [P3] stats-zero-state: empty data shows as an empty donut and 12 rows of zeros
- **What:** "Where a run's tokens go" (`stats/StageStats.jsx`) shows a blank donut with "$0.00 per run" and a 12-row legend of "$0.00 0% 0s" when no finished run has token data. Runs shows "Median duration 0s · Avg fix rounds 0.0". Also "Other (1 models)" (`stats/SpendByModel.jsx` l.22).
- **Fix:** When the version total is 0, render one muted line: "No finished run has token data yet. Stage costs appear once a run finishes with usage recorded." Pluralise: `` `Other (${t.count} ${t.count === 1 ? 'model' : 'models'})` ``.
- **Suggested command:** clarify

### [P3] raw-ids-in-copy: internal ids appear where names exist
- **What:** The Stages timeline shows `answer gate1`, `stage frame` (`RunSide.jsx` l.182–183, `e.kind` + `e.stage`). The editor's Edges list shows `gate1 -Agree spec→ plan`, `split -*→ prep`. The Stages Now card shows raw model ids.
- **Fix:** Map `e.stage` to the workflow node's `name` (it is in `detail.workflow`). In the editor's SettingsPanel edge list, use node names and "any" for `*`. Use `modelLabel()` (see now-totals-two-designs).
- **Suggested command:** clarify

### [P3] ledger-copy: a double negative and two names for one tag
- **What:** "Nothing here can't be undone." (`LedgerTab.jsx` l.173). The tag "Can't undo" (`src/ledger.js` l.388) sits under the card head "Can't be undone". The filter is called "Machines".
- **Fix:** Use "Every change in this run can be undone." Set the tag label to "Can't be undone" in `src/ledger.js` `TAGS.permanent`. Rename the filter to "Servers & data".
- **Suggested command:** clarify

### [P3] IDENTITY inter-everywhere: Inter for everything (detector `overused-font`)
- **What:** `web/src/fonts.css:4`: one sans family for UI, headings and figures. "Inter for everything" is on the refuse list.
- **Why it stays:** Inter is part of the affectUI identity this app keeps. Swapping it would change the brand.
- **Smallest in-identity alternative:** Keep Inter. Get more character from the type itself: the heading steps above (flat-heading-scale), `font-feature-settings: "cv11", "ss03"` for display figures, and JetBrains Mono kept strictly for ids, paths and commands (it is today, apart from the Stats `.legend-value` amounts, which can go back to Inter with `tnum`).
- **Suggested command:** typeset

## AI-slop refuse-list check

| Item | Hit? | Where |
|------|------|-------|
| Identical icon+heading+text card grids as page structure | No | The editor Palette is an icon+name+text list, but it is a functional tool palette, not page structure. |
| Nested cards | **Yes** | `.card.crew-main` > `.card.ag`; `.side-card` > `.ui-tclc` (nested-cards). |
| Hero-metric template | **Partly** | Monitor `.stat-strip` (duplicates the inbox count); Stats `KpiStrip` (justified there). |
| Eyebrow / kicker above headings | Minor | Vendored `.ui-tclc__label` "ARGUMENTS"/"RESULT" (10px uppercase) inside an expanded tool call. `.nav-head` "Views" is a nav group label, not a kicker. |
| Section numbers 01/02/03 | No | |
| Gradient text | No (false positive) | The detector flagged the vendored shimmer overlays; the text underneath is solid and the shimmer is turned off under reduced motion. |
| Glass / blur as decoration | No | Blur appears only in 2–3px vendored enter/exit transitions. |
| Side-tab border | **Yes** | `.waiting-card { border-left: 3px solid var(--warn) }`. |
| Hard offset shadows | No | |
| Sparklines / progress rings standing in for content | No | The stage stepper and context bar carry real values, with a text label beside each. |
| Monospace as costume | Minor | Stats `.legend-value` dollar amounts. Elsewhere mono is used for ids, paths and commands only. |
| Emoji / unicode glyphs as icons | **Yes** | Graph legend and node status (✓ ✕ ⏸ ▶ –), Finished disclosure ▸/▾, "Open run →". |
| Ghost cards (hairline + wide soft shadow) | Borderline, IDENTITY | `--elev-1` = 0.5px ring + `0 3px 12px` soft shadow is the affectUI card elevation. No change; the in-identity step is to drop the inner cards (nested-cards). |
| Over-rounded cards (>16px) | No | `--r-card: 10px`. |
| Pulsing dot as decoration | No | `.conn .dot` is static. |
| Inter for everything | **Yes, IDENTITY** | inter-everywhere. |
| Purple-to-blue gradients | No | |
| Gray text on coloured backgrounds | No | Pills use hue-matched text; `.rc .ask` on `--warn-bg` uses `--text`. |
| Rounded-square icon tile above every heading | No | Ledger `.ico` and palette tiles lead rows; they do not sit above headings. |

## Persona red flags

Personas: Alex and Sam (the rubric's pick for a dashboard), plus Casey, because Monitor is also used on a phone. Each walks the three primary actions: answer a waiting question, watch a running run's crew, check what a run changed.

**Alex (impatient power user)**
- *Answer:* No key jumps to the waiting question or sends it (no Ctrl+Enter in the inbox `textarea`). Reaching "Agree spec" from search takes several Tab presses.
- *Answer:* The Fleet quick answer is fast but sends an empty reply, and shows "Stop run" next to "Agree spec" with no confirm.
- *Watch:* 14 equal cards. The Tool calls rail says "sonnet-en…" six times, so Alex can't tell which engineer failed a call without clicking cards one by one.
- *Watch:* The lead is labelled "reviewer".
- *Changes:* Ledger rows aren't links: the commit sha `3e95cc2`, the push range and the Hephaestus task can't be opened from the row.

**Sam (keyboard and screen reader)**
- *Answer:* Good. Rows are `article`s labelled "Waiting on you: …", the count heading is `aria-live`, and focus moves to the next question after an answer. But "Stop run" isn't marked as destructive, and "Answered" is announced only for 1.1 s before the row leaves.
- *Watch:* The name buttons announce "sonnet-engineer, toggle button, not pressed" five times with nothing to tell them apart. The run tabs announce "tab" but ignore the arrow keys. The Stages graph is a `role="group"` of unlabelled nodes, so the rail is Sam's only view of stage state.
- *Everywhere:* The sidebar announces Stats as `aria-current="page"` and "Running" as pressed at the same time.

**Casey (distracted mobile user)**
- *Answer:* At 390 the question starts about 540px down, under the nav chrome and four KPI tiles. The `button.sm` actions are about 23px tall: this passes WCAG 2.5.8 through spacing, but is well under 44px.
- *Watch:* Tapping an agent filters a list about 2,000px below. Nothing in view changes except a blue ring.
- *Watch:* The Stages graph pane (60vh) captures touch drags, so scrolling past it is hard. Its zoom controls cover a node.
- *Changes:* The Ledger works well at 390.
- *Workflow:* The editor is unusable (the canvas is 0px wide).

## Minor observations

- **Cognitive load:** moderate (3 checklist failures).
  - Single focus fails on Monitor (the tiles compete with the inbox).
  - Working memory fails on Crew (agent identity).
  - Minimal choices fails in the editor's SettingsPanel: 19 node buttons plus 30 edge buttons in one column, so more than 4 options are visible at once.
- **Emotional journey:** the peak moment, answering a gate, gets a 1.1 s check and then the card vanishes. The "Answered questions confirm, then fold away" note explains it, but a run-ending answer deserves a lasting result line ("Stopped run X · 2s ago"). The Ledger is the reassuring end of the journey.
- **Mid widths not tested:** the harness shoots only 1440 and 390. Between 769 and about 1100px, `.run-body` keeps a fixed 380px rail beside a tree column of about 340px (232px sidebar + 56px padding). This is a likely squeeze. Consider `@media (max-width: 1100px) { .run-body { grid-template-columns: minmax(0,1fr) 320px } }`.
- **Live updates:** `useLive` (`hooks.js` l.5) uses a trailing 250ms debounce with no max wait. A steady stream of events less than 250ms apart would delay every refresh until the burst ends. This is a code-level risk, not seen in the shots.
- **Theme button:** the sidebar theme button cycles Dark → Light → System and shows the *current* value ("Light"). A three-way `seg` or a menu would say what the click does.
- **Reduced motion:** the still `.ring` becomes a hollow circle ("○ Running"), which can read as "not started". Use a filled 7px dot (`.dot-active`) instead.
- **Accounts:** with switching off, the page shows only a notice naming an env var (`AGENT_MONITOR_ACCOUNTS=off`) and no accounts, although it says "read-only". Either list the logins read-only or say "Account switching is off on this machine" without the env var.
- **Crew hint placement:** "Select an agent to show its own tool calls…" sits at the bottom of a 1,300px card, far from both the first card and the rail. Move it under the Crew card head.
- **Tool call "unknown" status:** shows a bare "–" (first rail row). Add a text label ("no result recorded").
- **Avatar colours:** `.av-*` are hard-coded hex and identical in both themes (they pass contrast). Move them into the token blocks as `--av-lead` and the like.
- **React Flow:** its attribution text sits at the bottom right of both canvases. This is fine, noted for completeness.

## Detector findings

| Rule | Where | Verdict |
|------|-------|---------|
| `overused-font` (warning) | `web/src/fonts.css:4` (Inter, imported by `main.jsx`) | **Real, IDENTITY.** It matches the refuse list. Keep Inter (see inter-everywhere). |
| `gradient-text` (warning) | `web/src/vendor/affectui/thinking-loader.css:139` | **False positive.** It is the `.ui-tlc__shine::after` loading sweep laid over solid text (`content: attr(data-text)`), not gradient-coloured text, and it is removed under reduced motion (`.ui-tlc__shine::after { display:none }`). It does add to motion-scatter. |
| `gradient-text` (warning) | `web/src/vendor/affectui/tool-call-card.css:403` | **False positive.** Same pattern on running tool-call names (`.ui-tclc__shine::after`). |
| `bounce-easing` (advisory) | `web/src/vendor/affectui/tool-call-card.css:152` (`.ui-tclc__ok`, `cubic-bezier(0.34, 1.56, 0.64, 1)`) | **Real, minor.** The success check overshoots. Override the easing in `affectui-theme.css` rather than editing the vendored file (motion-scatter). |
| URL scans: Monitor, Crew 1440, Crew 390x844, Ledger, Stats, Workflow | `detect/url-*.json` = `[]`, exit 0 | **Empty, not clean.** No rendered contrast or tiny-text findings were reported. The output carries no element count, so this run cannot confirm the SPA had rendered when the engine read it. It does not match the 9px graph text and the 10–11px vendor labels seen in the shots, which may simply be under the rule's threshold. Stages, Fleet, Accounts and the views were not URL-scanned. |
| Harness page checks | `shots/shots.json`: 52 shots, 0 console errors, 0 horizontal overflow | **Partly misleading.** `workflow-*-390` reports overflow 0 because `main.full { overflow:hidden }` clips the editor (workflow-editor-phone-broken). |

Where the two assessments agree or differ:
- They agree on Inter and on the motion overshoot.
- The detector also caught the vendored overshoot, which the design review had only folded under motion-scatter.
- The detector missed the side-stripe (`.waiting-card`, not rendered in any scanned URL) and the glyph icons.
- Every P1 and P2 here (identity, guarding, layout, glossary) is outside what the rules can see.

## Applied

Status is for the snapshot `db45139` (worktree `C:/wt/am-crew-ledger-after`), checked against the "after" shots in `shots/after/shots/` and, where a shot can't show it, the code. Totals: **21 fixed, 4 partly, 0 not fixed, 1 skipped (by design).**

| Id | P | Status | What changed (files) | Evidence |
|----|---|--------|----------------------|----------|
| gate-answer-ends-run-unguarded | P1 | partly | The server marks an answer whose edge enters an End node `ends: true` (`src/store.js`). In the inbox and on Fleet cards that answer is a red `danger` button, and the first click shows "Stop the run? This can't be undone. Confirm / Cancel" (`EndConfirm.jsx`, `vendor/affectui/decision-inbox.tsx`, `Fleet.jsx`). Still open in the snapshot: the run page's WaitingCard sends "Stop run" in one click (`WaitingCards.jsx` l.80, a path the before report also missed). Fix step 3 (no quick answers on Fleet when the gate takes a reply) was not done. **At HEAD:** the WaitingCard gap is closed (it confirms too, `cca1169`). **Fleet quick answers: skipped.** Quick answers stay by Ryan's choice, and the reply box is one click away. | `monitor-light-1440.png`, `monitor-dark-1440.png` (red Stop run); confirm is code only |
| lead-shown-as-reviewer | P1 | fixed | A type that names a role (lead, verifier, white-hat, reviewer) decides the role before description words (`lib/crew.js` `roleOf`, `SPECIFIC_TYPE`). | `run-crew-light-1440.png`: "fable-lead", purple L avatar; rail says "fable-lead" too |
| agents-indistinguishable | P1 | fixed | `agentLabel()` numbers repeated names ("sonnet-engineer 2") on the cards, the Stages Now card, the rail, the filter button, Fleet and avatar labels. The rail's agent column is wider at 12px and hidden while a filter is on (`lib/crew.js`, `CrewTab.jsx`, `RunSide.jsx`, `Fleet.jsx`, `RunBits.jsx`, `affectui-theme.css`). Side effect: the call target is now cut short (see new issue N2). | `run-crew-light-1440.png`, `run-crew-selected-light-1440.png` ("Clear filter (sonnet-engineer 1)", no agent column) |
| workflow-editor-phone-broken | P2 | fixed | At ≤768px the palette, canvas (60vh) and settings stack, and `main.full:has(.editor)` lets the page scroll (`styles.css`). | `workflow-light-390.png` |
| stages-graph-framing | P2 | partly | Stages opens at zoom 1 framed on the running or waiting nodes. Stop edges hide behind a "Show stop edges" toggle. On phones the pane no longer captures drags and the zoom controls move to the top right (`run/RunGraph.jsx`). **Left as it is, on purpose:** the graph opens fitted to the active stage at a readable size, and off-screen nodes are a pan or Fit away. Fitting everything brings back the 9px text the finding complained about. The editor label overlap stays as P3. What the snapshot showed: at 1440 the Decision and Fix column is cut at the right and Frame, Gate 1 and Plan sit above the top. "regression / env / stuck" is still crossed by an edge. The editor canvas still crops nodes at 1440, and its "Request changes" and "Stop run" labels still overlap. | `run-stages-light-1440.png`, `run-stages-light-390.png`, `workflow-light-1440.png` |
| inbox-below-kpis | P2 | fixed | While something waits, the inbox renders before the tiles (`Monitor.jsx`). At 390 the question now starts at about y=325 (it was about 540). Hiding the phone nav and Views row was dropped on purpose in review ("Keep the Views row on phones"). | `monitor-light-390.png` vs `before/…/monitor-light-390.png` |
| sidebar-two-selected | P2 | fixed | `Sidebar` gets `routeName`. A View shows as pressed only on the Monitor (`Sidebar.jsx`, `App.jsx`). | `stats-light-1440.png`: only Stats is selected |
| unknown-cost-shows-zero | P2 | partly | `formatCost(null)` returns "–", and Totals says "Not priced yet" when the agents report tokens but the run total doesn't (`lib/format.js`, `run/RunSide.jsx`). **No visible change on this data:** the server sends `cost: 0, total: 0` for agents it could not attribute (`run-detail.json`; zeros from `src/attribution.js` `emptyAcc`), even though the agents table holds their token counts. So every card, the header, the run row and Totals still read "$0.00 / Tokens 0", next to "Spend today $4.22". The root cause is on the server. **At HEAD (UI side):** a zero token total counts as "not read yet", so crew cards, the Crew header total, the Fleet card and crew strip, and Totals show "–" for cost (and "–" for tokens when no agent has any). Real tokens at zero cost still read "$0.00" (`run/RunSide.jsx` `costOfUsage`, `CrewTab.jsx`, `Fleet.jsx`). The run header still shows the server's $0.00 (outside this change). | `run-crew-light-1440.png`, `monitor-light-1440.png` |
| crew-equal-weight | P2 | fixed | The Crew "Now" card is gone. Finished agent cards are outline-only with a muted task (`run/CrewTab.jsx`, `styles.css` `.ag:has(.pill.done)`). | `run-crew-light-1440.png`, `run-crew-dark-1440.png` |
| now-totals-two-designs | P2 | fixed | One `Totals` (tokens, cost, duration, breakdown) is shared by Crew and Stages. The Stages Now card uses `modelLabel()` and says "no activity for 2m" only after 60s (`run/RunSide.jsx`). | `run-stages-light-1440.png` ("Opus 5.5", no "idle 14s") |
| status-glossary-drift | P2 | fixed | Stats Runs says "Done · Stopped · Running or waiting". Stopped is grey in Stats and in `StatusIcon` (`stats/RunsPanel.jsx`, `styles.css` `.si-stopped`). | `stats-light-1440.png`, `view-finished-light-1440.png` |
| phone-agent-select-offscreen | P2 | fixed | At ≤768px, picking an agent scrolls the Tool calls card into view (`run/CrewTab.jsx` `onSelect`). | code + `web/test/impeccable-apply.test.jsx`; full-page shots can't show a scroll |
| waiting-card-side-stripe | P3 | fixed | A full warm tint, an inset ring and a clock icon replace the left stripe (`styles.css`, `WaitingCards.jsx`). | code; no shot shows a waiting run's own page |
| glyph-icons | P3 | fixed | The graph legend and node status use `StatusIcon` (decorative). The Finished disclosure uses an SVG chevron (`run/RunGraph.jsx`, `editor/FlowNode.jsx`, `run/runState.js`, `Monitor.jsx`). The "Open run →" text arrow remains. | `run-stages-light-1440.png`, `monitor-light-1440.png` |
| hardcoded-name | P3 | fixed | "Waiting on you", "waiting on you", "Waits for your answer". No "Ryan" is left in `web/src`. | `run-stages-light-1440.png` legend, `workflow-light-1440.png` palette |
| run-tabs-no-arrow-keys | P3 | fixed | Roving `tabIndex`, plus Left/Right/Home/End that move focus and open the tab (`run/RunHeader.jsx` `onTabKeys`). | code + `impeccable-apply.test.jsx` |
| nested-cards | P3 | fixed | `.crew-main` is a plain header row, and rail tool calls are rows divided by lines (`styles.css`, `affectui-theme.css`). | `run-crew-light-1440.png` |
| small-text-tail | P3 | partly | Chips, stage pills, badges, tags, `.ctx`, `.group-count` and the tool-call agent are now 12px. Unchanged: `.av` 10.5px, `.av-more` 10px, `kbd` and `.nav-head` 11px, vendored `.ui-tclc__label` 10px uppercase. These are left on purpose: avatar letters and kbd hints are badges, not reading text. | `styles.css` l.101, 127, 134, 163 |
| flat-heading-scale | P3 | fixed | Card heads are 14px. `.group-head` is 13px `--text-2`. h1 is 20px / -0.015em, and the run h1 is 19px. | `monitor-light-1440.png`, `run-crew-light-1440.png` |
| needs-you-count-x4 | P3 | fixed | The "Needs you" tile is dropped while the inbox shows, and the oldest wait moves to the inbox note (`Monitor.jsx`). | `monitor-light-1440.png` |
| motion-scatter | P3 | fixed | No ring inside the running pill. The Crew Now loaders are gone. The success check easing is overridden to `cubic-bezier(0.16,1,0.3,1)` (`RunBits.jsx`, `affectui-theme.css`). The Stages Now card keeps one loader per running agent. | `run-crew-light-1440.png` |
| finished-rows-repeat-status | P3 | fixed | An ended row hides a stage pill that repeats its status, and "round 0/5". The Finished view has a plain header (`RunList.jsx`, `Monitor.jsx`). | `view-finished-light-1440.png` |
| stats-zero-state | P3 | fixed | One muted line in place of the empty donut, and "Other (1 model)" (`stats/StageStats.jsx`, `stats/SpendByModel.jsx`). Left as is: the version table under the line still reads "0 · $0.00 · 0s", and Runs shows "Median duration 0s · Avg fix rounds 0.0". | `stats-light-1440.png` |
| raw-ids-in-copy | P3 | fixed | The timeline uses stage names ("answer Gate 1: solution"). The editor edge list uses node names and "any". The model shows as "Opus 5.5" (`run/RunSide.jsx`, `editor/SettingsPanel.jsx`). The event words "stage / answer / log" are still raw. | `run-stages-light-1440.png`, `workflow-light-390.png` |
| ledger-copy | P3 | fixed | "Every change in this run can be undone.", the tag "Can't be undone" (`src/ledger.js`), the filter "Servers & data" (`run/LedgerTab.jsx`). | `run-ledger-light-1440.png` |
| N2 call target squeezed | P3 | fixed (HEAD) | The tool-call header row wraps. The summary keeps at least 14ch and the agent label drops under the tool name when space is tight (`affectui-theme.css` `.ui-tclc__main`, `.ui-tclc__summary`, `.ui-tclc__agent`; vendored .tsx untouched). | `shots/final/shots/run-crew-light-1440.png`, `run-crew-dark-390.png`, `run-stages-light-390.png` |
| N3 Main card footer misaligned | P3 | fixed (HEAD) | `margin-left: auto` on `.agfoot` in the wide container rule (`styles.css`). | `run-crew-light-1440.png`: Main session footer sits right, like the other cards |
| IDENTITY inter-everywhere | P3 | skipped | Kept by design: Inter is part of the affectUI identity. The heading-scale step above is the in-identity change. | `detect/source.json` still reports `overused-font` |

**Later commits, after the snapshot.** These are not in `db45139`, not visible in the shots and not scored below:
- The stop confirm is limited to answers that really stop the run. This replaces the snapshot's rule that any edge into an End node counts (new issue N5).
- Keyboard focus moves into the confirm and back again (clears N1).
- The run page's WaitingCard asks to confirm too. This closes the remaining gap in gate-answer-ends-run-unguarded, apart from the Fleet text-field rule.
- Activity summaries are redacted (a security change, with no design effect).

**HEAD changes after the re-score.** The scores in "After" were measured on the snapshot and are not changed. The N2, N3 and cost changes above came after the re-score, so they are not reflected in them.

## After

Method: the same dual setup as "before". A is a design review of the snapshot worktree `C:/wt/am-crew-ledger-after` at `db45139`: 15 of the 52 shots viewed (plus crops), with the diff `7cf4fb0..db45139` read for what shots can't show. B is the deterministic harness `harness/run.py after` on percy: the same seed, 52 Playwright shots (13 pages x light/dark x 1440/390) with overflow and console checks, and the same `npx impeccable detect` command on `web/src` and the same 6 URLs (the version is not logged). The detector JSON was read before scoring. Its output matches "before" exactly, so it could not move a score. Evidence: `C:/Users/ruyek/.claude/fable-runs/am-crew-ledger/shots/after/`.

**Nielsen (/40)**

| # | Heuristic | Before | After | Why |
|---|-----------|--------|-------|-----|
| 1 | Visibility of System Status | 3 | 3 | "idle 14s" and the stale View highlight are gone, but every run figure still reads "$0.00 / Tokens 0" next to "Spend today $4.22". |
| 2 | Match System / Real World | 3 | 3 | Stage names, node names, model labels, "Servers & data" and "you" replace the ids. Still raw: "stage / answer / log", "-done→" edge syntax, agent types as names. |
| 3 | User Control and Freedom | 2 | 3 | Ending answers in the inbox and on Fleet now confirm. Still no undo, and in the snapshot the run-page WaitingCard stops in one click. |
| 4 | Consistency and Standards | 2 | 3 | One Totals, one name per agent, one status glossary, SVG icons throughout. Left: the run page guards answers differently from the inbox, and Totals "Duration 12s" sits under a header "19s". |
| 5 | Error Prevention | 2 | 3 | The stop answer is red and asks first. Fleet still sends an empty reply on gates that take text, and the WaitingCard is unguarded in the snapshot. |
| 6 | Recognition Rather Than Recall | 3 | 3 | Calls map to an agent now ("sonnet-engineer 2" in tree, rail and filter). But a number doesn't say which task, the call target is cut to a few characters, and there is still no legend for the role avatars. |
| 7 | Flexibility and Efficiency | 3 | 3 | The run tabs take arrow keys. There is still no key to jump to or send the next answer. |
| 8 | Aesthetic and Minimalist Design | 3 | 4 | The Crew tab is calm: no duplicate Now card, quiet finished cards, no cards in cards. Monitor leads with the question. The finished rows and the Stats donut no longer repeat themselves. |
| 9 | Error Recovery | 2 | 2 | Unchanged: errors are still the raw `e.message` with no next step. |
| 10 | Help and Documentation | 2 | 2 | A few new in-context notes ("not priced yet", the Stats empty line, "Show stop edges"). Still no role or avatar legend and no docs link. |
| **Total** | | **25 (Acceptable)** | **29 (Good)** | |

**Audit (/20)**

| # | Dimension | Before | After | Why |
|---|-----------|--------|-------|-----|
| 1 | Accessibility | 3 | 3 | Tabs follow the ARIA pattern, chips are 12px, decorative icons are hidden, and Stages node text is readable at zoom 1. New in the snapshot: focus drops to `<body>` when the confirm replaces the answer buttons (N1). Avatars and vendor labels stay at 10–11px. |
| 2 | Performance | 3 | 3 | Fewer looping animations on Crew. `.acct-bar b` still transitions `width`. |
| 3 | Theming | 3 | 3 | The new tints are built from tokens with `color-mix`, and dark mode holds (`run-crew-dark-1440.png`, `monitor-dark-1440.png`). The `.av-*` avatar colours are still hard-coded hex. |
| 4 | Responsive Design | 2 | 3 | The editor stacks, the Stages pane lets the page scroll, the controls no longer cover a node, the question is near the top at 390, and picking an agent scrolls to its calls. Still one breakpoint, no mid-width rule, and the rail call targets are squeezed at 390. |
| 5 | Implementation Integrity | 2 | 3 | The lead label, two-design cards, glyphs, side-stripe, hard-coded name and double selection are all fixed. Left: the misleading $0.00 (server zeros), the WaitingCard path, and the Main session card misalignment (N3). |
| **Total** | | **13 (Acceptable)** | **15 (Good)** | |

**Detector, before -> after**
- Source (`web/src`): 4 -> 4. The same four findings: `overused-font` (Inter, IDENTITY), `gradient-text` x2 (the vendored shimmer, false positive) and `bounce-easing` (`tool-call-card.css:152`). The bounce is still reported because the rule reads the vendored file. The override in `affectui-theme.css` neutralises it at runtime, which a static scan can't see.
- URLs: the same 6 (Monitor, Crew 1440, Crew 390x844, Ledger, Stats, Workflow): `[]` -> `[]`, exit 0. The before caveat still applies: empty does not prove clean.
- Harness page checks: 52 shots, 0 console errors and 0 horizontal overflow, before and after. After, `workflow-*-390` really does have no overflow, because the editor now stacks instead of being clipped.

**New issues found**
- **N1 [P2, snapshot only]** When "Stop run" turns into the confirm, the clicked button unmounts and keyboard focus falls to the page. A keyboard user has to tab back in from the top (`vendor/affectui/decision-inbox.tsx` confirm branch, `Fleet.jsx` `QuickAnswers`). Fixed by `cca1169` (focus moves into the confirm and back).
- **N2 [P3, fixed at HEAD: the header row wraps and the agent label drops under the tool name]** The wider agent label (`affectui-theme.css`: `.run-side .ui-tclc__agent { flex:none; max-width:60% }`) cuts the call target to 4–8 characters ("tool_u…", "web/s…"), worst at 390 (`run-stages-light-390.png`, `run-crew-light-1440.png`). Suggested: cap the agent at about 45% and give the summary a minimum width, or move the agent to a second line under 480px.
- **N3 [P3, fixed at HEAD: `margin-left: auto` on `.agfoot`]** On the Main session card, the duplicate description is now hidden (`run/CrewTab.jsx` l.44). The cost and "1 helper" then drop to the left edge, misaligned, unlike every other card. The cause is `.agfoot { flex: none }` in the ≥600px container query (`styles.css` l.342); `margin-left: auto` on `.agfoot` fixes it (`run-crew-light-1440.png`).
- **N4 [P3, left on purpose]** Agent numbers follow spawn order because that is stable: tree order would renumber agents as parent links resolve. The numbers follow spawn order, not tree order. The tree reads "sonnet-engineer 1, 5, 2, 3, 4", and "general-purpose 2" sits above "general-purpose 1" (`lib/crew.js` `agentLabel`). This is defensible, but numbering in tree order, or a short task tag, would read more cleanly.
- **N5 [P3, latent]** `endsRun` (`src/store.js`) flags any answer whose edge enters an End node. A workflow with an approve answer that goes straight to "Done" would show a red "Stop the run? This can't be undone." The shipped workflow has no such answer. Fixed by `cca1169`, which limits the confirm to answers that really stop the run.

**Verdict.** The pass fixed the two jobs the before report called weakest. A run-ending answer is now red and asks first on Monitor and Fleet, and the waiting question leads the page. The crew can be told apart, and the lead is named as the lead. The Crew tab is calmer: no duplicate Now card, quiet finished cards, no cards in cards. That lifts Nielsen from 25 to 29 and the audit from 13 to 15, both into "Good". What still holds the scores down was mostly outside this pass: run costs still show a confident "$0.00", because the server reports zeros for usage it could not attribute; errors give no next step; there is no help for roles. Also, the Stages graph and the editor still crop the workflow at 1440. The later commits close N1, N5 and the WaitingCard gap. The next most useful fix is to send `null` from the server for unattributed cost, so the client's "–" and "not priced yet" can show.
