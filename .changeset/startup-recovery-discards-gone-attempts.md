---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/server": patch
---

Startup recovery stops tracking a finished attempt whose machine and checkout are both gone, so later starts skip it instead of visiting it at every start. `Executor.recover` and `StepExecutor.recover` now return `RecoveredLeftovers` from `@usine/core/attempt/salvage`: `gone` when neither the attempt's machine nor its checkout is left, otherwise `found`. When a recovery returns `gone` for a closed attempt, the engine sets its `leftoversDiscardedAt` after recording the attempt's comments, through the new `RunStore.discardClosedAttempt`. Open attempts and attempts whose recovery failed stay tracked. Startup logs one summary per configured worker with the attempts visited, kept, and discarded. The per-attempt lines "Resolved retained SSH machine for attempt recovery", "The Attempt's machine is gone", and "The Attempt's sandbox is gone" are now logged at debug level.

The first preparation on a remote worker after a start no longer warns about the checkouts of attempts that are being reattached: the attempt that started the sweep, and each attempt whose parent task `isLive` reported live. The sweep logs the remaining paths under `attempts/` as one warning with their count, and the paths at debug level.
