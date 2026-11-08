---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A queued CI fix takes approval, agent, models, permissions, CI policy, outcome labels, and `max_cycles` from its loop's current configuration when its run opens. Its prompt and failure evidence stay as recorded. Current settings also apply when a GitHub read error or recheck timeout permits admission. Approval expressions use the saved event payload. The generated CI handoff instructions follow the current CI policy.

When a CI fix and a trigger match wait on the same loop and item, the newest event that passes its recheck opens the next run and supersedes older events. A non-matching event is revoked on its own before the next candidate is rechecked; a missing item revokes the whole queued group. Reconciliation no longer rechecks CI fixes queued behind a running attempt.

The cycle budget reset response lists the CI fix events it replayed in `replayedCiFixEventIds`. A failed run in Needs attention links to the newest admitted CI fix run that has not been canceled or revoked.

Breaking API changes:

- `TriggerCondition.recheck` returns `TriggerRecheck.Matches({ submission })`, `TriggerRecheck.NoLongerMatches()`, or `TriggerRecheck.ItemGone()` instead of a string. Custom adapters must return the tagged result and include the submission for a match.
- `RunReader` implementations must provide `ciFixRuns(sourceRunIds)`, which maps source run IDs to their newest admitted CI fix run IDs.
- `CycleBudgets.reset` returns the replayed CI fix event IDs, or an empty list for a repeated answer.
- `POST /api/cycle-budgets/reset` returns `{ replayedCiFixEventIds: string[] }` instead of `{ ok: true }`. Update clients to read the new response.
