---
"@usine/orchestrator": patch
---

`Waiting for a free worker slot, behind N runs` counts the fewest runs that take a worker slot first, so the count doesn't overstate with several workers. A run that waits for a slot on its reattached attempt's worker counts only on the open worker with the fewest such runs: it no longer counts while another worker has none, and it still counts when every worker has one. `QueuedRun` adds `ahead`, which the desk now reads instead of the run's index in `WorkerStatus.queue`, and the `Run waits for a worker slot` log uses the same count.
