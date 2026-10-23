---
"@usine/engine": patch
---

After a restart, a reattached attempt occupies a slot of its worker, so the worker takes no new attempt beyond `max_concurrent_attempts`. At startup, the engine occupies a slot through `StepExecutor.occupy` for each attempt whose checkout it keeps for reattachment, and releases it only after `StepExecutor.interrupt` confirms that the parent task stopped. `RunStore.beginAttempt` logs `Reattached Attempt keeps its own Worker, not the reserved one` at error instead of warning.
