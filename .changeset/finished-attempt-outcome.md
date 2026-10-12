---
"@usine/durable": minor
"@usine/executor": minor
"@usine/engine": minor
"@usine/orchestrator": patch
---

An orchestrator that stops after an Attempt's parent finished, but before the engine recorded the Attempt's outcome, no longer runs the agent again as the next Attempt.

`AttemptRuntime.finished` reads what a finished parent left after its terminal envelope: its report, its failure, or the harvested result the executor stored with the new `AttemptRuntime.recordResult`. The durable session records the harvested result before it releases the checkout. `Executor.isLive` is also true for an Attempt whose parent reported success before its checkout was harvested, so the engine reattaches it and the reattachment harvests it. The new `Executor.outcome` and `StepExecutor.outcome` return the stored result or failure, and the engine finishes the open Attempt with it instead of failing it as interrupted. Only an Attempt that stored nothing is failed as interrupted.

`@usine/durable/testing`: a `StubStorage` task's `state` is a tagged value (`{ _tag: "live" }`, `{ _tag: "finished", report, result }`, `{ _tag: "canceled" }`), and a stub `execute` for a finished task returns its report.
