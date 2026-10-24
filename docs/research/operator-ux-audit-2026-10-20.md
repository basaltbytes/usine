# Operator UX audit, 2026-10-20

A walk through every screen of the live factory instance (main at ebfb373, 245 items, 153 runs, one project) as the operator uses it in a day. Method: Chrome screenshots, the overview API payload, the page sources, and the impeccable detector over `apps/web/src` (3 advisory findings in `typeset.css`, nothing structural). Single reviewer, not the two-agent critique.

Conclusion: the screens follow the data model (projects, board, runs, loops), not the operator's jobs. Each job below spans several screens, and the most important one, "why is nothing moving", has none.

## Operator and jobs

One operator, away most of the time, opens the UI in the morning after unattended overnight runs, during the day between other work, and when changing the instance. Jobs, by frequency and cost of a miss:

| # | Job | Today |
|---|-----|-------|
| J1 | Is anything waiting on me? Approve, answer, retry, reset. | Needs you strip, shown only when non-empty. Nothing says "nothing waits" or since when. |
| J2 | What is running now, on which worker, since when, is it making progress? | No view: a running run is a card with a coloured line in some lane, and no list shows attempts in flight. |
| J3 | Why is this item not moving? Held after a question or blocker, canceled and unchanged (deduplicated), loop paused, budget used up, no free worker, waiting for approval. | Nowhere (see [Board](#board-projectsownername)). |
| J4 | Read what a run did, and intervene. | Run page and drawer: the best part of the product. |
| J5 | Hand work to usine, or run it again. | Board move, Run again. Works, but only from a card the operator must find. |
| J6 | Read the instance configuration (loop prompts, agent models, worker capacity, repositories), then change it. | A Loops table only, read-only (see [Configuration](#configuration-configuration)). |
| J7 | What did this cost, how healthy are the workers and the harness pools? | Nothing. Tokens only inside transcripts, worker preflight only in the startup log. |

## Screen findings

### Home (`/`)

A one-row table: repository, Status "Clear", Open Runs "None", 245 Items, 9 lanes. On a 1500 px screen it fills the top 200 px of the panel and leaves the rest empty. Status is undefined, and no number is actionable.

With one operator and one or two projects, the home must be the desk instead: J1, J2, J3, and the last outcomes, in that order.

### Board (`/projects/:owner/:name`)

- **It can't explain a stall.** The Ready lane has 7 items with no run line while `start-dev` is active, and the home says "Open Runs: None". All 7 have canceled runs and no new event; nothing says they need a change or a run again.
- **Empty lanes dominate.** Five of nine lanes are full-width "No tasks" columns to scroll past before Pull requests, Done, and Unmapped. Done (168) and Unmapped (64) collapse to vertical tabs; expanded, Done is an unordered wall of merged pull requests and closed issues.
- **Flow arrows between lanes are blank** whenever nothing runs (#345), so the board doesn't show which loop acts on which lane.
- **Clicking a card** opens GitHub in a new tab without a current run, and the run drawer with one: one gesture, two destinations, one outside the app. The card menu has Open on GitHub and Move to.
- **The Pull requests lane is full of dependabot PRs** usine never touches: the board shows all of GitHub, not usine's work.
- **An item's history is unreachable.** Succeeded and canceled runs "stay in the drawer and Run history", but with no task page, a past run is reachable only by URL or from a card that has one now.

What works: lanes are the operator's labels, dragging writes to GitHub, the card's failure note has Retry, and the drawer.

### Run drawer and run page

The run page is the strongest screen: an outline of task, event, and attempts with durations, the reader with the failure boxed, the salvage note, and Retry and Edit and retry in the header. The drawer summary (outcome, bullets, actions) has the right shape. Smaller gaps:

- "18 errors" in the outline footer counts tool failures the agent recovered from, so the operator reads a broken run.
- No worker, total duration, tokens, or cost on the page (J7).
- Attempt rows show a date and a duration, not why the attempt started (retry by whom, infra retry, reattach).
- The outline of truncated first sentences works for a short run and is noise over 40 turns.

### Configuration (`/configuration`)

Redirects to Loops: a table of name, trigger kind, agent name, and paused state, with Pause and Reload configuration buttons, capped at 768 px (#400). No loop content is shown (#401): the `if:` condition, selector, approval, cycles, permissions, step, prompt. There are no pages for agents, workers, repositories and lanes, or settings. The reload result is a toast.

The operator edits the files in an editor and uses the UI only to pause.

### Global

- The sidebar has three entries and a "live" dot. It never shows that something is running, failing, or waiting, so the operator opens the home or a board to find out.
- No page shows when its data was last updated or when the last poll ran.
- No search, command palette, keyboard navigation, or lookup of a run by issue number.
- Every page has a 768 px content cap meant for prose (#400).
- Empty and loading states are a sentence ("Loading Run...", "No tasks"), with no skeletons or teaching empty states.
- The visual language (Catppuccin, Inter, JetBrains Mono, restrained colour) is fine.

## Build order

Each step is one screen, built with the frontend-design skill loaded, shipped as its own PR, and dogfooded on the factory instance before the next. The order follows each job's cost of failure.

1. **The desk**, replacing the home. Four blocks in reading order: Needs you ("nothing waits, last check at ..." when empty); Running now (one line per attempt in flight: item, loop, agent, worker, started, last activity, connectivity); Not moving (every item a loop matches with no open run, and its J3 reason); and Last outcomes (the last N runs and their results). A bottom line shows each worker's name, slots used, and last preflight. This answers J1, J2, and J3 on one screen and needs two new API pieces: the per-item stall reasons the engine already knows, and the attempts in flight.
2. **A task page.** The item, its runs in order with outcomes, the pull requests, the comments usine posted (harvested since #392), and the actions (Run again, move). Cards link here instead of to GitHub, which is one link on the page. This makes J5 reachable and gives succeeded and canceled runs a home.
3. **Board, second pass.** Cards show the stall reason from step 1. Empty lanes collapse to a narrow strip. Done and Unmapped become filters, not lanes. Flow arrows name the loops that watch each lane (#345). A default filter hides items no loop can match, such as dependabot PRs.
4. **Configuration as a real section.** Loops, Agents, Workers, Repositories with their lanes, and Settings, each a list with a read-only detail view of the whole parsed file (#401); the Workers page with capacity and last preflight per harness; and the reload result as a page, not a toast. Editing (#40) comes later and reuses the detail views.
5. **Run page, third pass.** Worker, total duration, tokens per child and pool (J7's per-run half), why each attempt started, turns grouped in the outline, and an error count of only the failures the run ended with.
6. **Usage and health.** The month's tokens and estimated cost per loop and per pool (#35), worker and gateway health, and the last poll per repository.
7. **Cross-cutting, with each step.** Page width per page kind (#400), sidebar counts for Needs you and Running, last-updated on every page, keyboard focus, and a command palette once there is more than one project.

Steps 1 to 3 are the product. Without them the operator runs usine from the terminal log, as today.

## Open decisions

- **Desk or board as the home?** The plan picks the desk; each project's board stays one click away.
- **Every open GitHub item on the board, or only what a loop can match?** The plan hides unmatched items by default.
- **Is a task page worth more than board polish?** The plan says yes: it's the only place for a run's history.
- **How much of J7 matters now?** Cost per run is cheap once the run page shows tokens; the Usage page is a separate decision.
