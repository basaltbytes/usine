# The v1 web UI: projects as home, a kanban board per project

The UI centers work, not machinery. Home lists the projects (managed repos as the operator sees them) under a global needs-you strip. A project opens as a board, a kanban of the repo's items in lanes. Each lane maps GitHub labels or states (`label: ready`, `state: pr open`), configured per repo from proposed defaults and synced both ways (usine never deletes a label). Cards show the item and its live run: agent, run state, and any error or approval awaiting the operator. Dragging a card writes the label swap to GitHub, which fires label-protocol loops, so the board is a trigger surface. A card opens the run drawer: the event (dedup key, payload summary), attempts with typed errors, and the transcript, with child sessions collapsible one level under parent messages. Loops, agents, workers, and lane maps are in Configuration.

## Considered options

- **Runs console as home** (CI-dashboard run queue): the densest view, but the operator thinks in projects and items, not run rows; the drawer reuses its design.
- **Loops as home** (a page of loop cards): puts configuration where the work should be; its loop-file view moves to Configuration.
- **Intervention inbox as home**: right instinct, too narrow for a whole surface; it remains as the needs-you strip and card badges.
- **Projects with kanban** (chosen): the only option showing _what agents are working on_ in the operator's terms, with label lanes making the board a trigger surface for free.

## Consequences

- v1 interventions: **Approve**, **Retry**, **Steer** (message the Pi parent), **Interrupt** (pause at the next tool boundary for a steer), **Cancel**, **Pause a loop** (no new runs; runtime state per [ADR 0009](./0009-instance-repo-remote-optional-runtime-state.md)), **Child takeover** (davis-style attach to a harness child), and **Edit-and-retry** (amend context before the next attempt). Takeover and edit-and-retry get their own ticket: the attempt channel ([ADR 0006](./0006-executor-contract-run-host-attempt-channel.md)) addresses only the parent.
- Diffs: the drawer links the run's PR. v1 has no diff view, and the stored transcript allows one later.
- Needs-you (approvals, agent failures, steerable runs) is global: a strip on home and badges on project and board cards, so you don't need to know which project to check.
- Lane maps are per-repo configuration in the instance repo, proposed from a fresh repo's labels. Board sync projects polled trigger state ([ADR 0007](./0007-polling-triggers-content-hashed-events.md)); no new data source.
- Proposed lanes are read-only: only an authored lane map says which labels the board may swap, since labels like `bug` aren't safely workflow state. Cards offer moves only to another authored label lane, and the server rejects moves to proposed lanes. Authored moves keep labels outside the map. To enable moves, configure `repos[].lanes` in `usine.yaml` and restart. This settles the write question in [#76](https://github.com/basaltbytes/usine/issues/76).
- **Project** joins the glossary as the operator-facing term (a managed repo with its board and activity); _managed repo_ stays the registry mechanism.
- The prototype on `prototype/v1-web-ui` validated structure only; its visual language was rejected, and the look is a separate ticket.

## 2026-10-20: the board hides what no loop acts on

The 2026-10-20 audit found the board showing everything on GitHub: five of nine lanes empty, 232 cards in Done and Unmapped, dependabot PRs filling Pull requests, and nothing saying why seven Ready items had no run. The board now shows the lanes and tasks loops act on, the rest behind header toggles:

- An empty lane collapses to a narrow column with its name, count, and labels, and widens to accept a drag.
- The fallback lane and closed-only lanes move to header toggles, off by default, with counts. Toggled on, they're last in the row, so Unmapped cards can still move to authored lanes.
- A task no loop can match is hidden until **Show all Items**: no trigger matches its items, its current item has no authored-lane label, it has no open run, and nothing about it waits in Needs you. The orchestrator uses the poll's `LoopMatches` evaluation, so board and poll agree.
- The arrow between two authored lanes lists the loops whose trigger matches a left-lane task, open run or not ([#345](https://github.com/basaltbytes/usine/issues/345)); listing only working loops left it blank when idle.
- A card on the overview's Not moving list shows its reason and action, read from the desk view rather than recomputed.

## 2026-10-20, later: every lane in one row again

After trying it live the same day, the operator rejected collapsed empty lanes, toggled Done and Unmapped, and hidden unmatched tasks. The board went back to every lane in one row, empty lanes at full width, Done and Unmapped last as rails, and every task the overview returns. Loop arrows and stall reasons stayed.
