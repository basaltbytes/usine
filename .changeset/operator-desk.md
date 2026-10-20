---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

The web UI opens on the desk instead of the Projects list. The desk shows, in order: Needs you, with `Nothing waits on you.` and the time of the last finished poll when it is empty; Running now, one row per Attempt in flight with its Item, Loop, Agent, Worker, start time, last activity, and open connectivity warnings; Not moving, each Item a Loop's trigger matches with no Attempt running on it, the reason, and the action that moves it again; Last outcomes, the 10 Runs that closed last; and each Worker's slots in use and last preflight. The sidebar lists the Projects under a Desk entry.

`RunReader.sightings` reads, for each Loop that has seen one of the supplied Items, the Event of the state it last saw match (following the newest reopening or run again), the Run that Event owns, and the Run whose question or blocker holds the Loop on the Item, as `LoopSighting`.

`OperatorObservation.desk` returns a `DeskView`. Its Not moving list comes from the orchestrator's `LoopMatches` service, which pairs each issue and pull-request Loop with the stored Items its trigger matches now, evaluated as the poll evaluates a changed Item. A matched Item that is not moving carries one typed reason: `AwaitingApproval`, `HeldForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. The operator API adds `GET /api/desk`, which also answers in setup mode. The desk's Workers line reads `WorkerStatus` and carries each Worker's `WorkerSlotsView` and the `PreflightCheckView` that stands. `OperatorObservation.layer` now requires `ExpressionEngine` and `WorkerStatus`; `WorkerStatus.idle` serves a process that runs no Attempts. `PollCycle.repositoryPolls` gives when each repository last completed a poll in the process.
