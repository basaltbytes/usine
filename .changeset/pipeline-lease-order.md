---
"@usine/config": minor
"@usine/engine": minor
"@usine/orchestrator": minor
---

A free worker slot goes to the waiting run furthest along the pipeline, not to the run whose event arrived first. Before, later stages such as review and finish waited behind every queued first-stage run when the worker was full.

The scheduler ranks waiting runs with `leaseOrder` (`packages/orchestrator/src/lease-order.ts`): a reservation that names a worker, then a run of a loop with `priority`, higher first, then a run by the lane its trigger matched, later lane first, then any other run. Event order ranks runs at the same position. The lane is the first lane in the repository's `lanes` with a label of the item in the run's event, which is the lane the board keeps a running card in. Each lease logs `Worker slot leased in lease order` with the run, the loop, `positionSource`, `position`, and `passed`.

`@usine/config/loop` adds `LoopPriority` and `LoopFile.priority`, parsed from the optional `priority` key of a loop file, a positive integer.

`StepExecutor.reserve` takes the run ID as its first argument.

`WorkerStatus.queue` lists the waiting runs in lease order (`QueuedRun`). `QueuedForWorkerView` adds `ahead`, the number of runs before the run in the queue, or null if the scheduler doesn't queue it. The Overview shows it as `Waiting for a free worker slot, behind 2 runs`.
