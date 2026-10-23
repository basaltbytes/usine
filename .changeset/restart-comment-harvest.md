---
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
---

At startup, the engine records the comments that an open attempt posted on its run's item if its parent task failed before the orchestrator stopped. `@usine/core/attempt/salvage` exports `RecoverySink`, which `Executor.recover` and `StepExecutor.recover` take instead of the salvage callback, with a `comments` recorder.
