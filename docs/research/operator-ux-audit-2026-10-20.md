# Operator UX audit, 2026-10-20

A walk through every screen of the live factory instance (main at ebfb373, 245 Items, 153 Runs, one Project), as the operator would use it during a day. Method: screenshots of each screen in Chrome, the overview API's payload beside them, the page sources, and the impeccable detector over `apps/web/src` (3 advisory findings in `typeset.css`, nothing structural). This is a single-reviewer pass, not the two-agent critique.

The conclusion first: the screens are built around the data model (Projects, Board, Runs, Loops) and not around what the operator comes to the UI to do. Every job below has to be assembled by the operator from several screens, and the one job that matters most during the day, "why is nothing moving", has no screen at all.

## Who, and when

One operator, away most of the time. They open the UI in three situations:

1. **Morning, after a night of unattended Runs.** What happened, what waits on me, what failed and why.
2. **During the day, between their own work.** Is the factory doing something right now, is it stuck, did the Run I kicked off finish.
3. **When changing the factory.** A Loop prompt, an Agent's model, a Worker's capacity, a new repository.

Jobs, in order of how often they come up and how much a miss costs:

| # | Job | Today |
|---|-----|-------|
| J1 | Is anything waiting on me? Approve, answer, retry, reset. | Needs you strip, only when non-empty. Nothing says "nothing waits" and nothing says since when. |
| J2 | What is running right now, on which Worker, since when, is it making progress? | Nowhere as a view. A running Run is a card somewhere in a lane with a coloured line. No list of Attempts in flight. |
| J3 | Why is this Item not moving? Held after a blocker, canceled and deduplicated, Loop paused, budget used up, no free Worker, waiting for approval. | Nowhere. Today the Ready lane shows 7 Items and the home says "Open Runs: None", with no reason on either. All 7 have Canceled Runs and no new Event; the operator cannot tell that from any screen. |
| J4 | Read what a Run did, and intervene. | Run page and drawer. The best part of the product. |
| J5 | Hand work to the factory, or run it again. | Board move, Run again. Works, but only from a card the operator has to find. |
| J6 | Read the factory's configuration, then change it. | Loops table with four columns. No Agents, Workers, repositories, lanes, settings. No detail, no editing. |
| J7 | What did this cost, how healthy are the Workers and the harness pools? | Nothing. Tokens exist only inside transcripts. Worker preflight only in the startup log. |

## Where each screen fails

### Home (`/`)

A one-row table: repository, Status "Clear", Open Runs "None", 245 Items, 9 lanes. On a 1500 px screen it uses the top 200 px of the panel and the rest is empty. Status is a word with no definition. The numbers carry nothing the operator acts on.

This is not a home. It is a list of one Project. For a single-operator product with one or two Projects, the home has to be the desk: J1, J2, J3 and the last outcomes, in that order, before anything else.

### Board (`/projects/:owner/:name`)

- **It cannot explain a stall.** The Ready lane holds 7 Items with no Run line on any card. The Loop `start-dev` is active. Nothing anywhere says the previous Runs were canceled and the Items need a change or a Run again. J3 fails on the screen that is supposed to answer it.
- **Empty lanes dominate.** Five of nine lanes are empty, each a full-width column with "No tasks", and the operator scrolls past them to reach Pull requests, Done and Unmapped on the right. Done (168) and Unmapped (64) collapse to vertical tabs; expanded, Done shows merged pull requests and closed issues as a wall of cards with no order the eye can read.
- **Flow arrows between lanes are blank** whenever nothing runs (#345), so the Board does not say which Loop acts on which lane. The factory's own logic is invisible on its own Board.
- **Clicking a card opens GitHub in a new tab** when the card has no current Run, and opens the Run drawer when it has one. Same gesture, two different destinations, one of which leaves the app. The card menu offers two things: Open on GitHub and Move to.
- **The Pull requests lane is filled with dependabot PRs** the factory will never touch. The Board shows everything on GitHub, not what the factory works on.
- **No way to reach an Item's history.** Succeeded and Canceled Runs "stay in the drawer and Run history", but there is no Task page: the only way to a past Run is a card that currently has one, or a URL.

What the Board gets right: lanes are the operator's labels, drag writes to GitHub, the card's failure note with Retry, the drawer.

### Run drawer and Run page

The Run page is the strongest screen: outline of Task, Event, Attempts with durations, the conversation reader with the failure boxed, the salvage note, Retry and Edit and retry in the header. The drawer summary (outcome, bullets, actions) is the right shape.

Gaps, all smaller than the rest of this document:

- "18 errors" in the outline footer counts tool failures the Agent recovered from as if they were problems; the operator reads it as a broken Run.
- No Worker, no duration total, no tokens or cost anywhere on the page (J7).
- Attempt rows show a date and a duration but not why a new Attempt started (retry by whom, infra retry, reattach).
- The reader's outline is a list of truncated first sentences; it works for a short Run and becomes noise over 40 turns.

### Configuration (`/configuration`)

Redirects to Loops. The Loops page is a table of name, trigger kind, Agent name, paused state, plus a Pause button and a Reload configuration button, capped at 768 px (#400). Nothing of what a Loop is reaches the screen (#401): the `if:` condition, selector, approval, cycles, permissions, step, prompt. There is no Agents page, no Workers page, no repositories and lanes page, no settings. The reload result is a toast.

The operator writes these files in an editor and uses the UI only to pause. For J6 the UI is absent.

### Global

- The sidebar has three entries and a "live" dot. It never shows that something is running, failing, or waiting. The operator has to open the home or a Board to learn that a Run needs them.
- No page says when its data was last updated or when the last poll ran.
- No search, no command palette, no keyboard navigation, no way to find a Run by issue number.
- Every page shares a 768 px content cap meant for prose (#400).
- Empty and loading states are a sentence ("Loading Run...", "No tasks"). No skeletons, no teaching empty states.
- The visual language (Catppuccin, Inter, JetBrains Mono, restrained colour) is fine and not the problem. The problem is what the screens are for.

## What to build, in order

Each step is one screen done properly, with the frontend-design skill loaded, shipped as its own PR, dogfooded on the factory before the next starts. The order follows the jobs' cost of failure.

1. **The desk** (replaces the home). Four blocks in reading order: Needs you (with "nothing waits, last check at ..." when empty), Running now (one line per Attempt in flight: Item, Loop, Agent, Worker, started, last activity, connectivity), Not moving (every Item a Loop matches that has no open Run, with the reason: held after a question or blocker, canceled and unchanged, Loop paused, budget used up, waiting for a Worker, awaiting approval), and Last outcomes (the last N Runs with their result). Workers' state in one line at the bottom (name, slots used, last preflight). This answers J1, J2, J3 on one screen and needs two new pieces of API: the stall reasons the engine already knows per Item, and the Attempts in flight.
2. **A Task page.** The Item, its Runs in order with outcomes, the pull requests, the comments the factory posted (now harvested, #392), and the actions (Run again, move). Cards link here, never to GitHub by default; GitHub is one link on the page. Fixes J5's reachability and gives Succeeded and Canceled Runs a home.
3. **Board, second pass.** Cards carry the stall reason from step 1. Empty lanes collapse to a narrow strip. Done and Unmapped become filters, not lanes. The flow arrows name the Loops that watch each lane (#345). A filter hides Items no Loop will ever match (dependabot and the like) by default.
4. **Configuration as a real section.** Loops, Agents, Workers, Repositories with their lanes, Settings: one list each with a read-only detail view that shows the whole file as parsed (#401), the Workers page with capacity and last preflight per harness, and the reload result as a page not a toast. Editing (#40) comes after and reuses the detail views.
5. **Run page, third pass.** Worker, total duration, tokens per child and pool (J7's per-Run half), why each Attempt started, an outline that groups turns instead of listing sentences, and an error count that means failures the Run ended with.
6. **Usage and health.** The month's tokens and estimated cost per Loop and per pool (#35), Worker and Gateway health, the last poll per repository.
7. **Cross-cutting, alongside each step.** Page width per page kind (#400), a sidebar that shows counts for Needs you and Running, last-updated on every page, keyboard focus and a command palette once there is more than one Project.

Steps 1 to 3 are the product. Without them the operator runs the factory from the terminal log, which is what happens today.

## Decisions this needs from the operator

- **Is the desk the home, or is the Board?** The plan says desk. The Board stays one click away per Project.
- **Should the Board show every open Item on GitHub, or only what a Loop can match?** The plan hides unmatched Items by default.
- **Is a Task page worth more than Board polish?** The plan says yes, because it is the only place a Run's history can live.
- **How much of J7 matters now?** Cost per Run is cheap once the Run page carries tokens; the Usage page is a separate decision.
