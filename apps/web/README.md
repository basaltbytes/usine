# @usine/web

The usine web UI, served by `@usine/server`. Internal; never published.

## Issues and pull requests

A task is named after its originating item: the earliest issue, or else, for a task with no issue such as a Dependabot pull request, the earliest pull request. Every page titles a task or run with that item's mark and title, so a pull request number is in a title only for a task without an issue. The task's other pull requests appear as marks beside it, never in the title.

A mark is the item's GitHub icon and number in GitHub's state colour: an issue icon or a pull request icon, open, merged, or closed. It links to the item on GitHub, and its tooltip says the kind, number, and state, such as `Pull request #530, closed`. A mark inside a row, card, or entry that opens something else doesn't link. While a state is unknown, the mark shows the kind's icon in the muted colour.

## Needs attention

Peach-tinted entries in two columns at the top of every screen except the overview, where they're the first block; absent when empty. Each entry has a title, project, detail line, and actions; an entry about a run opens its drawer. On the run page, entries take one line each, with the full detail in a tooltip. The sidebar shows the total beside **Overview** and a count per project.

Entries:

- **Approval**: the loop and the task's name, with **Approve** and **Cancel run**. While any screen sends an action on the run, the buttons are disabled and name it, such as `Approving…`. The entry leaves when the action succeeds, before the overview refreshes. A refusal because the run changed state, for example after approval from the drawer, shows only in the drawer and run page; the entry leaves with the refresh.
- **\<loop\>: blocked** or **Question from \<loop\>**, with the agent's blocker or question. **Mark resolved** (**Mark answered** for a question, in its drawer and run page) lets the run's loop act on the item's newest state.
- **Failed run**. **Mark resolved**, in its drawer (from **Needs attention** or **Run history**) or run page, clears the warning and its project and board attention, across reloads and restarts, and keeps the outcome, attempt details, transcript, and retry controls. A later failed attempt raises it again.
- **Cycle budget used up** on an item, with the loops and their counts. **Reset cycle budget** records an explicit answer and refreshes the overview; the runtime fetches current trigger input before opening more work.
- **Child-session budget used up**, with the configured and attempted counts, also shown in the drawer and reader.
- **Loop file not loaded** or **Agent file not loaded**: a file that failed to load at startup or reload, with the reason, until fixed and reloaded.
- **Worker not configured**: a worker no longer in `usine.yaml` that has recorded attempts, with their count and the full detail, actions below. Startup doesn't reconcile them. Declare the worker again and restart `usine up`, or choose **Discard leftovers** and **Confirm discard** to stop tracking them. The discard removes the attempts' Codex homes from an SSH worker that usine recorded, and leaves their checkouts for you to remove. While attempts a reload left there still run, the entry says how many (`2 attempts still running on it. Discard the leftovers after they end`), and **Discard leftovers** appears after the last ends. A refused discard, for example because the worker is declared again, shows the reason.

A failed run, question, or blocker on an item that is closed or merged isn't listed and doesn't mark the project or its card; the run stays under **Recent runs** and in its drawer, which marks the item closed or merged. A cycle budget entry leaves at the first poll after its item closes or merges. A run in a repository that `usine.yaml` no longer lists isn't listed either, since it has no project to mark.

## Overview

The first screen, at `/`:

- **Statistics**: a switch between `7 days`, `30 days` (the default), and `All`, then four blocks about the tasks done, a task being done when its pull request merges. **Tasks done**: the count, the median time in usine from the first run's opening to the last run's close, and the median price of the priced tasks, over a dot per task by merge day and time on a log scale with the median as a line; a dot opens its task, and windows counted per week show tasks per week over the median per week. **Time per task**: a bar that splits a task's time between the loops and waiting, then one line per loop such as `finish-pr about 15 min`. **First time right**: the share of tasks with no second round and the operator actions per task, each with a sparkline. **Tokens per task**: the median tokens and the split by loop. One line under the blocks names the tasks left out, such as `19 tasks before 19 Oct lack timing and are left out`. **Details**, collapsed, holds the run statistics and reads them only once opened: runs closed, median run and attempt time, runs in one attempt, runs closed per day by outcome, Needs attention entries per day with their waits, a table of runs per loop or agent or attempts per model, attempts per run, queue wait, and slot use per worker. A window without a task done says so in one line, such as `No tasks done in the last 7 days`. Switching windows dims the previous figures until the next arrive. Each chart's values are also in a table or label for screen readers.
- **Needs attention**, or `Nothing needs attention` with the time of the last finished poll.
- **Running**: one row per attempt in flight: the task's name, loop, agent, worker, start time, last activity, and open connectivity warnings in yellow.
- **Stalled**: one row per item a loop's trigger matches with no running attempt, named by its task, with a reason such as `Canceled 2d ago, unchanged since` and the one applicable action: **Approve**, **Mark answered**, **Mark resolved**, **Reset cycle budget**, **Retry**, **Run again**, or **Resume**. A queued run whose machine a provisioned worker is creating reads `Creating a Hetzner machine, started 2m ago` instead of waiting for a slot. Below `md`, the loop, reason, and action stack under the item.
- **Recent runs**: the last 10 closed runs, with outcome and the pull request the run opened, unless it names the task.
- One line with each worker's slots in use and last preflight. A provisioned worker adds the count of its machines, if any, and while machine creation is paused, the failure and the next try in red, such as `Machine creation failed: quota reached. Next try at 19:46`.

A row about a run opens its run page. Empty blocks say what they would list, and loading blocks show skeleton rows. With no project registered, the overview points to `repos` in `usine.yaml` and offers **Reload configuration**.

## Sidebar

Lists the projects, each with **Board** and **Tasks** under it. The open page's row is highlighted; a project's own row opens its board.

## Board

A project opens as a horizontal board whose authored or proposed lanes group the latest GitHub issues and pull requests, all in one row, with every task the overview returns. It scrolls both ways below the project heading, with both ends reachable on any screen width.

### Lanes

Writable lanes come first in configured order, then read-only lanes, then the unmatched lane (Unmapped). Unmapped and lanes with only closed items (Done) start folded into narrow rails with name and count; a rail opens into a lane, and the lane heading folds it back.

The lane heading shows the name, card count, and the labels (in GitHub colors) and item states that route items there, and stays in view while cards scroll. An empty lane is a dashed outline with `No tasks`. During a drag, the lane under the pointer gets a muted background; with the keyboard, Left and Right move the dragged card one lane.

Between two adjacent authored label-backed lanes, an arrow at the end of the left lane's heading points to the next lane and names the loops whose trigger currently matches one of its tasks, open run or not, with `paused` after paused ones. It's blue if one has a queued or running run on the lane's tasks, peach if all their open runs wait for approval, and unlabeled if no loop matches.

Only authored label-backed lanes accept moves, and only if another writable lane exists; proposed, state-only, and unmatched lanes are read-only. A board with proposed lanes explains how to enable moves: configure `repos[].lanes` in `usine.yaml` and reload the configuration.

### Task cards

A card joins explicitly linked issues and PRs. It shows:

- Each member's mark, the task's title on at most two lines, and up to three labels besides the lane's own, with a count of the rest.
- For an open run, or a failed run that still needs the operator: a dot in the state's color (pulsing while `Running`), then the loop, state, time, and agent. The time counts from the run's opening while `Waiting` or `Queued`, the current attempt's start while `Running`, and the failure once `Failed`; the tooltip gives the full timestamp and start point. Succeeded and canceled runs show only on the task page, in the drawer, and in **Run history**.
- Under that line: failures on items that are still open, with **Retry** if retryable or **Mark answered** or **Mark resolved** for a question or blocker; merge conflicts; run action and **Run again** progress, including that no run opened because the cycle budget is used up; and move progress.
- For a stalled task, the overview's reason (from `GET /api/desk`), after the loop if no run line shows it, and the one action that unblocks it, such as **Approve** or **Run again**.

Clicking a card opens its task page. The card menu lists only actions that apply: each member on GitHub; **Open run** for the run shown; **Run history** if the task has other runs; **Approve** for a `Waiting` run; **Retry** for a `Failed` one on an open item; **Cancel run**, after confirmation, for an open run; **Run again** with the loop's name if the latest run succeeded or was canceled, which opens the new run's drawer even if the card changes lanes first; and **Move to** with the other writable lanes, absent if there are none and while a move is saving.

The menu button names the current issue or PR, whose labels a move changes. It shows on hover, on focus, and while the menu is open, and always on touch screens.

### Card moves

A moved card stays in its destination while the label write and GitHub refresh finish, showing saving, then saved and waiting for sync, with the old lane labels hidden. Other cards stay usable, and accepted moves persist across project switches. An unrelated label update doesn't undo a move; a newer lane or item state replaces it. While moves are pending, the board polls every second, so confirmation and approval prompts appear quickly. A failed write shows its error and reloads the board.

## Tasks list

At `/projects/<owner>/<name>/tasks`: the board's tasks with at least one run, finished ones included; other tasks appear only on the board and GitHub. With no runs at all, it shows `No runs yet`. A row opens the task page.

Columns:

- **Task**: the task's name.
- **Status**, then ` · ` and when the last run was last active, such as `Done · 28m ago`.
- **Runs**: the loops in first-run order, each with its last run's state mark, then the run count.
- **Pull request**: the task's other pull requests as marks.
- **Elapsed time** (the attempts' time, counting while one runs, such as `48 min`), **Tokens** (`1.2M`), and **Estimated cost** (priced dollars, `$20.55`): bare figures under their headers.

A muted `*` marks a figure lower than the real one: elapsed time while some attempts lack timing (`0s*`, reason in the tooltip), or cost while some usage is unpriced, such as a Claude session before its first result (reason at the top of the hover card). Hovering tokens or cost shows tokens per billing pool, summed over the runs.

The status is the first that applies:

1. `Running`, with the loop.
2. `Waiting for approval`.
3. The stall reason of a pending or queued run, as on the overview.
4. `Done`, after the current item's state icon, if the item is merged or closed and no run is open.
5. A stalled task's reason.
6. `Needs attention`, if a failed run or a suppression needs the operator.
7. The last run's outcome, such as `Failed`.

A stall reason includes its own time, such as `Canceled 3d ago, unchanged since`, and gets no second one.

Tasks in flight come first (running, waiting for approval, pending, queued, stalled), each by when its run opened, newest first. A stalled task is in flight while an open run, an agent's question or blocker, a used-up cycle budget, or an unresolved failure blocks one of its loops; its status names that stall. Other tasks follow by when their last run closed, newest first; a run canceled before any attempt counts from the cancel. This includes stalled tasks not blocked that way (last run closed on an unchanged item, item waiting for the next poll, loop paused, or failure resolved), which keep the stall reason as status.

The heading counts tasks without zeros, such as `2 in flight, 1 needs attention, 2 done`; a stalled task not in flight counts as needing attention only while a failed run or a suppression needs the operator. The line below totals the listed tasks, such as `197 runs, 12 h 8 min* elapsed, 127.5M tokens, $134.34* estimated`, omitting the cost if nothing is priced and showing a `*` only while a listed task's figure has one, with the reason in its tooltip.

Columns follow the table's width, not the window's; [`DESIGN.md`](DESIGN.md#layout) gives the breakpoints and column sizing. On a phone, the table never scrolls sideways.

## Task page

At `/projects/<owner>/<name>/tasks/<number>`, where the number is the originating item's: the earliest issue, or else the earliest pull request. Any member's number opens the page under that address. An item outside the board's 500 newest shows `Task not found`.

The header has the task's name; below it, the task's other pull requests, the lane, labels besides the lane's own, and **Needs attention** if it applies. **Move to** is at the right while another writable lane exists and no move is saving.

Sections:

- **Runs**: every run on the task's items, newest first: state, loop, item (if several), agent, attempts, attempt duration, open time, and the resulting pull request. Under the loop: a failed run's typed reason and message, who ran it again, and who approved it. Below 1280px, the other facts fold under the loop; below 640px, the state does too. A row opens its run page and shows **Approve** for a waiting run or **Retry** for a failed run that still needs the operator. The row menu has the other actions that apply, with **Cancel run** confirmed; **Edit and retry** and **Edit and run again** open the editor under the row.
- **Pull requests**: each one's mark and title, linked to GitHub, and any conflict with the base.
- **Comments and reviews**: what the runs' attempts posted, whatever their outcome, with item, run, and posting time (or attempt end, if recorded before posting times were), each linked to GitHub.

Empty sections say how they fill. The page refreshes every 2 seconds while a run can be canceled, every 15 seconds otherwise, and when the overview refreshes after a run action or move.

## Run drawer

A run opened from a card menu, **Needs attention**, **Run history**, or **Run again** on the task page shows in a drawer over the current screen:

- Above the title: the loop and agent.
- The task's name.
- Under it: the run's state and its pull request, which is the one the run opened, else the item if it's a pull request, unless it names the task.
- Once an attempt has started: the duration of all attempts, counting while one runs, and the newest attempt's worker, followed by its machine's provider ID while a provisioned worker holds one for it. Then `Loop paused` if the loop is paused.
- The actions for the run's state (see [Run actions](#run-actions)).
- An outcome paragraph: a succeeded run's result; a failed run's typed reason, message, and salvage; what a waiting or queued run waits for, such as the machine being created for its next attempt; or a running run's current activity and latest message.

Each item appears once. Names and states come from the task's board card. If the board doesn't show the task, the run's item names it, with its state from the newest poll if it's closed or merged, and the pull request has no state.

**Open run page**, or the expand icon beside **Close**, opens the run page; with view transitions and without reduced motion, the title and state animate from the drawer into the page.

### Run actions

The drawer and run page show only the actions that apply: a primary button, a secondary button, and **More actions** with the rest.

| Run | Primary | Secondary | More actions |
| --- | --- | --- | --- |
| Waiting for approval | **Approve** | | **Cancel run** |
| Pending, queued, or running | | **Cancel run** | |
| Failed with a question | **Mark answered** | **Edit and retry** | **Retry** |
| Failed with a blocker | **Mark resolved** | **Edit and retry** | **Retry** |
| Failed otherwise | **Retry** | **Edit and retry** | **Mark resolved** |
| Succeeded or canceled | | **Run again** | **Edit and run again** |

Once a question or blocker is marked answered or resolved, the run's actions are those of any other failure. If a failed run can't be retried, **Mark resolved** is the primary button. **Cancel run** asks for confirmation with **Confirm cancel** and **Keep running**.

## Run page

At `/projects/<owner>/<name>/runs/<run>`: the whole run under the drawer's header and actions. The line under the title adds the tokens the sessions used, such as `159.6K tokens`; the total opens a breakdown per billing pool and per session under each attempt, priced by the harness or, for Codex, at OpenAI's API rates, with the Claude and ChatGPT plans as estimates.

**Run again**, on a succeeded or canceled run (or in the card menu for the task's latest run), opens a new run of its loop on the same item content with the run's task and agent; **Edit and run again**, under **More actions**, lets you change them first. The drawer or page then shows the new run, whose event says who ran it again, when, and from which run, linked by short id in the event document and on the task page. If the item's cycle budget is used up, no run opens and the actions say so. For **Edit and retry**, see [Intervening in a run](#intervening-in-a-run).

### Outline

The outline lists the task and the event with two-line previews, then each attempt with its outcome mark, start reason, start time, and duration, counting while it runs. Start reasons are the event, an operator retry, an edit and retry, a retry after an infrastructure failure, or a restart, marked if the restart reattached it.

While a provisioned worker creates the machine for a queued run's next attempt, the outline ends with **Creating machine**: the provider, the machine's ID once the provider assigns one, the attempt number, and the start time and age. The header's state reads `Queued, creating a Hetzner machine`.

An approved run of a gated loop adds a line to the event entry and the event in the reader, such as “Approved by octocat · 15 Oct 19:30 · from the UI”, or “from GitHub” for a 👍 on the ask. It omits the name if `usine.yaml` sets no `operator`, and shows only “Approved” and the time for runs approved before usine recorded approvers.

The attempt being read expands to its sessions (parent and children, with live status, hold state, and working time), then its checkpoints in order. Consecutive messages of one session fold into one entry, such as “developer, 14 messages”, listing each message by its first sentence, cut to a clause or whole words. Blockers, questions, operator messages, worker and provider notices, and the outcome are separate entries named by speaker; a blocker or the final failure is red, and a warning yellow.

Scrolling the reader expands the attempt in view and marks the checkpoint at the reading line. Selecting the task or event shows it in the reader (the event with **Raw details** for its payload); selecting an attempt, session, or checkpoint scrolls to it. Below 1024px, the outline is a disclosure above the reader, and a finished run opens at its outcome's time line.

Under the outline, a red count with previous and next controls steps through loaded errors: failed attempts' outcomes, blockers, questions, operator input a session refused, and open connectivity warnings. A quieter count, such as “12 recovered”, steps through tool calls that failed while the agent continued, expanding the fold and call.

**Resume details**, beside a Claude or Codex child, shows its saved session id, worktree, and **Resume this session**, a command to paste in your terminal:

- For a local worker, it changes into the worktree and resumes the session.
- For an SSH worker, it runs that over `ssh -t` to the worker's `destination`, with `-p` if `usine.yaml` sets `port`, quoted again for the remote shell; the worktree line names the worker.
- For a provisioned worker, which has no `destination`, it uses the local form to run on the attempt's machine and says that the machine is deleted with the attempt; the worktree line names the worker.
- For a worker that `usine.yaml` no longer declares, it uses the local form and says so.
- For a Codex child that saved its session in the attempt's own Codex home, as behind a gateway with `openai` in `llm_providers`, it sets `CODEX_HOME` to that directory before `codex resume`.

**Copy command** copies the wrapped command as one line. Resuming needs the attempt's harness login and its worktree, which attempt cleanup removes. For a child whose model requests used the gateway's credential, the line under the command reads `The gateway credential isn't available from your shell` instead of naming the login. On a provisioned worker, where such a child used the gateway's credential or the provisioner's API key, a second line under the machine note reads `The gateway credential or API key isn't available from your shell`. Older transcripts and Pi children say no harness session was saved.

### Reader

Each attempt is one document. Its first line names the worker, parent model, each child's harness, model, and effort, the account rate-window readings, and whether the operator intervened. Messages from the parent, children, and operator follow at a 72-character measure, with time and speaker in a narrow column.

Calls between two messages fold into one line that says what ran, such as “Ran 5 commands · 25s” or “Edited conversation.tsx · ran tests.”, counting failed and running calls. File summaries count distinct paths and add parent directories to tell apart same-named files. Recognized test and build commands say what ran; results are in the tool details. Long or varied folds use compact counts, and loading earlier inputs fills in missing details.

An expanded fold shows each call as one row, start and finish together, naming the command, file, search, or delegated task. Commands show terminal output, reads show source, and edits show a patch or before-and-after text, each in a copyable panel; other tools show labeled parameters and readable results. **Raw details** has the complete input and output.

A label change, comment, or review the agent made on the run's item is a line under the fold of the calls that made it: “Removed agent-in-progress, added ready-for-review”, with labels in GitHub colors, or “Commented on” or “Reviewed” and the item's mark, linked to the comment or review. They come from the item's GitHub timeline (the App's changes during that attempt), not from commands, so a command that changed nothing adds no line. The run page reads them on open, when an attempt starts or ends, and every 30 seconds while one runs; if GitHub can't be read, a notice at the top says so.

Your board moves during an attempt go through the same App, but usine records each move before sending it, so the reader shows it as yours, like a timed operator note: “You moved it from Review to Findings on the Board”. Moves from before usine recorded them show as the agent's label change.

A delegation shows the task the parent gave. The attempt ends with its outcome: the failure note with its typed reason (including executor defects that need an explicit retry) and the salvage line, or the result. The parent's copy of a child's message, a final message the outcome repeats, a comment it links, and a label change it states in the same words, such as “removed `agent-in-progress`”, appear only in the outcome.

A live attempt shows its current activity under the last message, and the reader follows new activity until you scroll away; **Jump to latest**, in its own band at the bottom, resumes following. An attempt with unloaded history offers **Load earlier**, which keeps the reading position.

## Configuration

The instance folder as the orchestrator parsed it, read-only, in five full-panel pages: **Loops**, **Agents**, **Workers**, **Repositories**, and **Settings**. List rows open detail pages with the file's long parts beside a rail of short facts (rail first on phones).

- **Loop**: trigger and selector as written, the agent with its brain, the selected repositories, approval, cycle limit, permissions, step, and the prompt as Markdown with each `{{ }}` expression outlined. The database-backed **Pause** or **Resume** control is in the heading and on each list row.
- **Agent**: the persona and where its parent model and effort come from.
- **Worker**: connection and gateway settings (never the admin token), slots in use, and the last preflight of its own prerequisites and of each harness. The **Workers** list places a provisioned worker by its machines, such as `hetzner cx33 in nbg1, one machine per attempt`, and adds the failure and next try while machine creation is paused.
  - For a provisioned worker: the provisioner settings (provider; server type, location, image, network, firewall, SSH key, SSH user, and labels for Hetzner, or size for Boat) and the names of the variables with the provider token and the Anthropic API key, never their values. **Machines** lists each machine in flight, oldest first, with the provider ID, state (`Creating`, `Ready`, or `Deleting`), age, and the run it serves, which opens its drawer, or the attempt for a machine found after a restart. Above them, the last failed creation shows the reason, the provider's message, the failures in a row, and the next try. Harness checks run on the first machine of each day, so each harness reads `Deferred` until that check passes or fails.
- **Repository**: its lanes in board order with each label as GitHub has it, the labels usine creates there, and the loops that select it.
- **Settings**: `settings`, `operator`, the webhooks mode, and `tracing`, with what each value does.

A loop or agent file that didn't load comes first in its list; its page shows the parse stage, the message, and how to recover.

**Reload configuration**, in every page heading of the section, reloads the instance folder; the changes, skipped files, or refusal reason stay under the heading until dismissed or until you leave the section. **Pause** and **Resume** are absent in setup mode. Needs-setup mode states that new GitHub App credentials require restarting `usine up`, because the process reads them only at startup.

## Intervening in a run

A live attempt has a composer at the bottom of the reader for the parent, or for a child selected in the outline. **Pause session** waits for the next tool boundary; sending a message resumes. **Cancel run** asks for confirmation, then stops the whole attempt.

Messaging a child places a hold: the child can answer and take more turns in the same conversation while the parent waits for its result. **Release child** lets the result return once the child is idle. Each child has its own hold, a paused parent doesn't block messaging its children, and held children stay reachable even if their last activity isn't in the loaded transcript page. Holds pause the attempt's elapsed-time budget, but reported tokens still count toward `settings.max_attempt_tokens` if set. A failed or canceled attempt shows the salvage branch with its unfinished work, or the retained worktree path if the push failed.

Failed runs offer **Edit and retry**, with a task editor and a roster agent picker; the agent supplies its persona and model settings. The new task and agent apply to later attempts, including automatic infrastructure retries. Each attempt shows the task and agent it used and whether the operator intervened. Transcript messages and delivery receipts name the configured operator; the triggering event is unchanged.

## Returning to a conversation

The reader saves each run's expanded folds and tools and its reading place in this browser. Reopening or refreshing the run page, or reselecting the attempt after viewing the task or event, returns to the same row and position; a reader left at the latest activity keeps following. Wheel, touch, keyboard scrolling, and outline navigation override a pending restore.

To recover a saved row, the run page loads up to 20 earlier pages. If the row is unavailable, a request fails, or the limit is reached, a notice says the reader shows the nearest activity, and **Load earlier** stays available. Restoring a place, fallback included, keeps unread activity unread. The update count includes, once, each loaded row changed since the last acknowledged tail, such as a tool result that arrives after its start was read; earlier pages can reveal more. **Jump to latest**, or scrolling to the latest activity, acknowledges them; error and outline navigation don't.

Bookmarks expire after 30 days. Each browser origin keeps up to 20 runs, the 200 most recent disclosure choices per run, and at most 512,000 characters of bookmark data: identities, preferences, a row-relative position, and the acknowledged transcript sequence, but no transcript text or tool payloads. If browser storage is disabled or full, the conversation still works, but can't restore a saved place. See [ADR 0025](../../docs/adr/0025-run-conversation-reader-bookmarks.md).

## Conversation browser tests

Install the pinned Chromium once with `pnpm --filter @usine/web exec playwright install chromium`, then run `pnpm --filter @usine/web test`. Unit tests run in Node, and interaction tests in Chromium with the real MessageScroller, Base UI disclosures, sidebar, and layout. Board move tests replay stale refreshes, failures, concurrent card moves, and navigation during a request through the real HTTP client with controlled responses. CI installs Chromium and its OS dependencies first.

If the machine has its own Chromium, such as a worker built by [`infra/hetzner/cloud-init.yaml`](../../infra/hetzner/cloud-init.yaml), set `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` to its path instead. `vitest.config.ts` passes it to Playwright as `executablePath`, and `turbo.json` lists it in the `test` task's `env`, so `pnpm test` from the repository root sees it.

The tests use up to about 4.7 GiB of memory, roughly half in Vitest's process and most of the rest in Chromium. That's also the peak of `pnpm test` from the repository root, which runs one package's tests at a time. Give an attempt container that runs them at least 6 GiB (`memory_mib: 6144`), and run one such attempt at a time on a machine with 7.7 GiB, such as a Hetzner cx33 or cpx32. Two runs at once on that machine make it swap even when each container's limit allows them: browser tests time out, and the kernel kills processes for memory. The run page totals the processes the kernel killed for memory across an attempt's containers and separately gives the memory limit of the last container with recorded kills.

## Stack

React, TypeScript, TanStack Query, TanStack Router, Tailwind CSS, shadcn components on Base UI with Phosphor icons, GitHub Octicons for issue and pull request marks, and shadcn/typeset over react-markdown for prose. The visual system (ADR 0015) is dark-only on Catppuccin Mocha; [`DESIGN.md`](DESIGN.md) defines its colors, type, and components.

## How to add UI

The registry is the component library, and the theme is the only place for colors and type.

- **Use a registry component first.** Everything under `src/components/ui/` came from `pnpm dlx shadcn@latest add <name>` (run inside `apps/web`; `components.json` has the preset). Compose those primitives (`Item`, `Card`, `Badge`, `Sheet`, `Message`, `Collapsible`, `Empty`, …) in screen files. The full set is installed: check it before writing a new element.
- **Extend with tokens, not hex.** Colors, fonts, and radii are CSS variables in `src/index.css`, exposed to Tailwind through the `@theme inline` block. A new semantic color is a token pair there (`:root` and `.dark`) plus one `--color-*` line; screens then use utilities such as `text-run-active`. Never write a literal color in a component.
- **Render issues and pull requests with `src/components/item/`.** `ItemMark` is the only place that picks an item's icon, colour, and state words; `ItemHeading` puts a mark inline in a title; `PullRequestMarks` lists pull requests; `identity.ts` finds the item that names a task. Never print an item number another way.
- **Render a repository that names a page or a navigation entry with `RepositoryMark`** (`src/components/repository-mark.tsx`) before its name: the owner's GitHub avatar, or the name's first letter if it doesn't load.
- **Never hand-roll a parallel component.** No `styles.css`, no ad-hoc button or badge classes. A composition shared by several screens (for example `src/components/status-badge.tsx`) wraps a registry primitive in `src/components/`, next to `ui/`, keeping vendored and composed components apart.
- **Edit registry files in place** to fix type or a11y issues. They're exempt from the domain-model lint rules (`.oxlintrc.json` override), since upstream doesn't follow them. Import aliases follow the app's conventions. `knip` treats registry components as entry files, so unused components aren't reported.
- **Use AI Elements for conversation tools.** `src/components/ai-elements/` adapts the upstream Tool, CodeBlock, and Terminal components to Base UI, Phosphor icons, and the app's tokens (its README records provenance and changes). Fill these panels with readable tool content; complete transport payloads go under **Raw details**. shadcn MessageScroller handles conversation scrolling; every direct content row has a stable `MessageScrollerItem` identity.
- **Render Markdown with `Markdown`.** `src/components/markdown.tsx` renders agent and operator prose with react-markdown in a `typeset typeset-chat` container. `src/typeset.css` is the unmodified download from https://ui.shadcn.com/typeset.css; the `.typeset-chat` preset in `src/index.css` sets its options. Source and patches use CodeBlock, command output Terminal.
- **Screens are file routes** in `src/routes/`. Define the route component above `Route`, or import a larger screen from `features/<feature>/<name>.page.tsx`. Use `.page.tsx` only for screens. Feature folders use the route group's name: `overview` for `/`, `projects`, `tasks`, `runs`, and `configuration`. The Vite plugin regenerates the committed `src/route-tree.gen.ts`. The run drawer uses the root search parameter (`?run=`), so it overlays any screen; parse search parameters in the owning route's `validateSearch` and read them with `Route.useSearch()`.
- **Keep dependencies in one direction.** Routes compose features; features use shared `components/`, `hooks/`, and `lib/`. Features never import another feature. Put UI rendered by several features in `components/<feature>/`, and shared data or hooks in `lib/` or `hooks/`. Use `~/` for imports outside the current folder and named exports in application code.
- **Keep components small.** Declare `type <Component>Props` above each component with readonly fields. Extract subcomponents before a component file reaches 300 lines. Vendored `components/ui/` and `components/ai-elements/` keep their upstream structure. Put display text in feature `strings.ts` files, or shared `lib/strings.ts` modules.
- **Colocate tests.** Put unit and browser tests beside their implementation in `src/`; Vitest discovers `*.test.ts`, `*.test.tsx`, and `*.browser.test.tsx` there. Shared fixtures are in the corresponding `lib/<feature>/` folder; the memory router helper is in `lib/testing/`.
- **A rebuilt bundle needs no restart.** `@usine/server` reads `index.html` and `assets/*` from `apps/server/dist/web` on every request, so after `pnpm build`, reload the page. GitHub credentials, the `webhooks` and `tracing` blocks of `usine.yaml`, and some `workers` changes are read only at startup; the rest of the instance folder reloads from any configuration page.
- **Navigation is in `src/components/app-sidebar.tsx`**, built from the `sidebar` registry component. Screens render inside `SidebarInset` under a breadcrumb header; the panel has the viewport's height, and content below the header scrolls inside it.
- **Give a table's fill column `FillCell`** (`src/components/fill-cell.tsx`) instead of `w-full`. The column takes the remaining width, and its content wraps or is cut short instead of widening the table. Every other column shrinks to its content's narrowest width, so keep that content on one line, or give its cell a minimum width to wrap at.
- **Pick the page width.** `Page` takes `width="prose"` (default; content stops at 768px) for prose and short lists, or `width="full"` for tables and side-by-side layouts such as the configuration section.
- **Keep the scale.** `src/index.css` defines the only five sizes: `text-xs` (12px), `text-sm` (13px, the default), `text-md` (14px), `text-lg` (16px), and `text-xl` (20px); [`DESIGN.md`](DESIGN.md#hierarchy) assigns their uses. Other size utilities generate no CSS; arbitrary sizes are off the scale. Headings are Inter semibold; `font-mono` is only for ids, item numbers, times, and code; counts and times use `tabular-nums`. Use sentence case everywhere, with no uppercase labels.
