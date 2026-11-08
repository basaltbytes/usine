---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A queued CI fix takes approval, agent, models, permissions, CI policy, outcome labels, and `max_cycles` from its loop's current configuration when its run opens. Its prompt and failure evidence stay as recorded. The generated CI handoff instructions follow the current CI policy.

When a CI fix and a trigger match wait on the same loop and item, the newest event opens the next run. Reconciliation no longer rechecks CI fixes queued behind a running attempt.

The cycle budget reset response lists the CI fix events it replayed in `replayedCiFixEventIds`. A failed run in Needs attention links to the CI fix run that continues its work.

Breaking API changes:

- `TriggerCondition.recheck` returns `TriggerRecheck.Matches({ submission })`, `TriggerRecheck.NoLongerMatches()`, or `TriggerRecheck.ItemGone()` instead of a string. Custom adapters must return the tagged result and include the submission for a match.
- `RunReader` implementations must provide `ciFixRuns(sourceRunIds)`, which maps source run IDs to their newest admitted CI fix run IDs.
- `CycleBudgets.reset` returns the replayed CI fix event IDs, or an empty list for a repeated answer.
- `POST /api/cycle-budgets/reset` returns `{ replayedCiFixEventIds: string[] }` instead of `{ ok: true }`. Update clients to read the new response.
