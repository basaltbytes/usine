---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Startup no longer tries to reconcile the Attempts recorded on a Worker that `usine.yaml` no longer declares. It logs one warning per start with their count and the Workers, and Needs you lists each such Worker as an `UnconfiguredWorkerNeed`, exported from `@usine/orchestrator/operator`, with its Attempt count. Declaring the Worker again reconciles its Attempts at the next start. The Discard leftovers action (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them and changes nothing on the Worker. `StepExecutor` lists the Workers it runs as `workers`, `RunReader.attemptsByWorker` counts the Attempts startup reconciles per Worker, and a migration adds `leftovers_discarded_at` to `usine_attempts`.
