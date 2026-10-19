---
"@usine/engine": minor
"@usine/orchestrator": patch
---

A deleted or transferred issue that the queued-Event re-check finds missing now leaves the Board's open lanes. `TriggerCondition.holds` is replaced by `TriggerCondition.recheck`, which answers a `TriggerRecheck` from `@usine/engine/trigger-condition`: `matches`, `no-longer-matches`, or `item-gone`. The engine revokes the Item's queued Events for both of the last two, and for `item-gone` also marks the Item's projection gone with `ItemProjectionWriter.markGone`. The orchestrator's re-check answers `item-gone` when GitHub reports `GitHubItemNotFoundError`. An adapter that cannot tell answers `matches`, as `true` did before.
