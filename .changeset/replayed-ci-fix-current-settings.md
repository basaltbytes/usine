---
"@usine/engine": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

A queued CI fix takes approval, agent, models, permissions, CI policy, outcome labels, and `max_cycles` from its loop's current configuration when its run opens. Its task and failure evidence stay as recorded.

When a CI fix and a trigger match wait on the same loop and item, the newest event opens the next run. Reconciliation no longer rechecks CI fixes queued behind a running attempt.

The cycle budget reset response lists the CI fix events it replayed in `replayedCiFixEventIds`. A failed run in Needs attention links to the CI fix run that continues its work.
