---
"@usine/executor": minor
"@usine/orchestrator": patch
---

Create provisioned machines after persisting their attempt, with the attempt label present in the creation request. Retry provider failures within the same attempt and release its machine on cancellation. `WorkerMachines.create` now requires the attempt ID; the separate `assign` operation is removed.

Resume worker reservations when creation backoff expires, even if the attempt that started the pause was canceled.
