---
"@usine/executor": patch
---

`Executor.recover` reconciles the checkout of an open Attempt it is given, instead of leaving it when `isLive` reports the Attempt live. The orchestrator calls `recover` only for an Attempt that no Run reattaches, so `recover` first stops a parent task that durable storage still holds live. A parent's report that was never harvested no longer keeps the checkout from being salvaged before the Run's next Attempt starts.
