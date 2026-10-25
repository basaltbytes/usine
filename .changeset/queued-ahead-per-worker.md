---
"@usine/orchestrator": patch
---

`Waiting for a free worker slot, behind N runs` no longer counts a run that waits for a slot on its reattached attempt's worker while another worker takes attempts, so the count doesn't overstate with several workers. `QueuedRun` adds `ahead`, which the desk now reads instead of the run's index in `WorkerStatus.queue`, and the `Run waits for a worker slot` log uses the same count.
