---
"@usine/engine": minor
"@usine/orchestrator": patch
---

`StepExecutor.reserve` takes `worker: Option<WorkerName>`. With a worker, the lease comes only from that worker, and the scheduler serves the reservation before unnamed ones without blocking runs that another worker can take.

`StepExecutor` adds `occupy(worker)`, which takes a slot at once for an attempt already running on the worker, even beyond `max_concurrent_attempts`, and logs a warning in that case.
