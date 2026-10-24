---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.

Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
