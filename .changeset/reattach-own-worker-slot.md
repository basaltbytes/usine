---
"@usine/engine": patch
---

After a restart, a Run that reattaches its open Attempt reserves its slot on the Worker that Attempt runs on, by passing that Worker to `StepExecutor.reserve`. The reattached Attempt holds a slot of its own Worker, so that Worker takes no new Attempt beyond its `max_concurrent_attempts` while the reattached one runs. The Run reads whether the Attempt is live before it reserves, and again once it holds the slot, so an Attempt whose parent task stopped during the wait is reconciled instead of reattached. `RunStore.beginAttempt` logs `Reattached Attempt keeps its own Worker, not the reserved one` at error instead of warning.
