---
"@usine/executor": patch
---

`Executor.recover` reconciles the checkout of an open Attempt it is given, instead of leaving it when `isLive` reports the Attempt live. The orchestrator calls `recover` only for an Attempt that no Run reattaches, so `recover` first stops a parent task that durable storage still holds live. A parent's report that was never harvested no longer keeps the checkout from being salvaged before the Run's next Attempt starts. When the parent task cannot be confirmed stopped, because its liveness cannot be read or its cancel fails or outlasts the interrupt grace, `recover` fails with a `cancel` `ExecutorOperationError` and leaves the checkout in place, and `cancel` fails the same way instead of only logging it.
