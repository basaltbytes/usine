# Board tasks join explicitly linked items and their run histories

Work often starts with a development run on an issue, then review and fix runs on its PR; separate item cards lose that thread when the trigger label goes. The board instead shows a task: connected items in one project, with all their saved runs in order.

Only full PR URLs in an issue's observed `closedByPullRequestsReferences` or saved run results link items, and they must name a PR in the same repository. Number-only references in PR payloads may point elsewhere and don't count; titles, branches, and prompts are never used. Items stay separate until both snapshots and a link exist, within the 500-item board window.

The earliest issue number titles the task. The item with the newest open run sets the lane; between runs, an open PR wins, then the latest settled PR, then the originating issue. Label and state precedence apply to that current item, and moves target its GitHub number, shown in the UI. Approvals, failures, and cycle asks on any member flag the task.

The task is a read projection, with no stored identity or new lifecycle: run ownership, dedup, approval, retry, and per-item cycle budgets stay on their records. Connected components avoid duplicate cards when issues share a PR. The engine supplies every saved run summary for visible items, regardless of the overview's history limit.

The UI shows run and attempt counts, not task cost from rate-limit snapshots or durations from timestamps that don't record completion.

## 2026-10-20: the task has a page

Finished runs left the card, so only a card still showing a run led back. Clicking a card now opens the task's page, `/projects/<owner>/<name>/tasks/<number>`. Lacking a stored identity, the address uses the originating item (earliest issue, else earliest PR); any member's number finds the task, and the address then shows the originating item. The page reads the task through the board projection, so items, lane, and the 500-item window match. Its comments and reviews come from the runs' `Comment` facts, which have no time, so each is dated by the end of the succeeded attempt that recorded it.

## 2026-10-21: a running run keeps its card in its trigger's lane

A loop removes its trigger label first so it doesn't trigger again, so a running PR had no lane label and its card fell to a state lane like Pull requests, making the board look idle mid-review ([#467](https://github.com/basaltbytes/usine/issues/467)). Now, while a task's newest open run is `Running` and its current item is open, the task goes to the first label lane matching the item's labels when the trigger matched, read from the run's event payload (`RunReader.events` for running runs). Otherwise, or if no such label maps to a lane, the current item's labels and state place it. An unstarted run doesn't keep the card: its agent hasn't changed labels yet, and the poll revokes it once its trigger stops matching. Label changes during a run, by the agent or a board move, apply when it ends. No lane setting is needed, since the event records each run's origin.
