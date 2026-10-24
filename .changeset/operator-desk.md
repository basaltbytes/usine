---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.

Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
