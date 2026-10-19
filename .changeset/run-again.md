---
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

The operator can run a succeeded or canceled Run again. `RunState.operatorActions` adds `canRunAgain`, and `@usine/core/run/again` adds `RunAgain`, the Run that was run again and the operator login that asked.

`RunEngine.runAgain` takes a `RunAgainRequest` (the Loop's current Step, approval requirement, and cycle limit, the task and Agent, and who asked) and records a new Event for the Run's Item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`, where `n` continues the trigger Event's reopening numbers. It returns `Claimed` with the new Run, or `CycleBlocked` when the Item's cycle budget is used up, and fails for a Run in another state or while another Run of the Loop is open on the Item. A later poll of the unchanged Item joins the new Run. A migration adds the `usine_run_again_events` table, and `RunSnapshot` and `RunSummary` carry `runAgain`.

`Operator.runAgain` resolves the Agent from the roster and the Step, approval, and cycle limit from the loaded Loop file, and fails with the new `LoopNotFoundError` when the Loop is not loaded. The operator API adds `POST /api/runs/:runId/run-again` with the edit-and-retry payload, and `RunView` carries `runAgain` and `canRunAgain`.

The web UI offers Run again and Edit and run again on succeeded and canceled Runs, in the drawer and on the Run page, and shows the new Run. The new Run's Event says "Run again by <login> · <time> · from Run <id>".
