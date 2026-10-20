---
"@usine/core": patch
"@usine/engine": patch
"@usine/executor": patch
---

`@usine/core/attempt/salvage` exports `RecoverySink`, which `Executor.recover` and `StepExecutor.recover` take in place of the salvage callback, with a `comments` recorder beside `salvage`.

`@usine/engine` records at startup the comments an open Attempt posted on its Run's Item when its parent task failed before the orchestrator stopped.

`@usine/executor`: `recover` harvests those comments in the Attempt's checkout with a freshly issued credential before it salvages the checkout, and logs and records none when the checkout or the credential is gone.
