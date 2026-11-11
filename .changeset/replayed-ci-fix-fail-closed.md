---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

A queued CI fix no longer opens when its recheck can't read the pull request because of a GitHub error or the five-second timeout. The fix stays queued, and the next reconcile rechecks it, so a GitHub outage right after a cycle reset can't admit a fix for a head that a newer push replaced. A queued trigger match still opens with its saved settings in that case.

Unpausing a loop rechecks the queued CI fixes at once instead of at the next periodic reconcile, and the request doesn't wait for those rechecks. While a cycle-budget reset is pending, polling calls `RunEngine.admitCiFixes` instead of running a full engine reconcile, and a failure there logs a warning instead of failing the poll. That call admits every queue whose newest event is a CI fix, on every loop and repository, not only the fixes the reset replayed. When such a fix no longer matches, the item's next queued event is rechecked, and if it is a trigger match that still holds, its run opens. A reset whose repository is no longer configured is acknowledged on the next poll.

Reconcile reads the admissible queues once per pass and admits each one, whatever the kind of its newest event. After a recheck mismatch, the next queued event is rechecked only while the item has no open run or suppression, so no GitHub read is spent on an event that can't be claimed. The reconcile summary logs at info only when it opened a run, started a fiber, or retried a stop.

Breaking API changes:

- `TriggerRecheck.Matches` carries `settings`, the Loop settings and task the run opens with, instead of a whole `submission`. The engine keeps the event, item, revision, cycle generation, and CI evidence as recorded. Adapters that keep the saved settings return `TriggerRecheck.Matches({ settings: savedSettings(submission) })`; `savedSettings` and the `AdmissionSettings` type are exported from `@usine/engine/trigger-condition`.
- `TriggerRecheck.Undetermined()` is a new result for a recheck that could not read the item. Adapters that matched on a failed read return it instead.
- `RunEngine` implementations must provide `admitCiFixes`, which admits the queues whose newest event is a CI fix, as reconcile does, and returns the run IDs it opened. Those can include a trigger match opened after a CI fix mismatch.
