---
"@usine/orchestrator": patch
---

The queued-event recheck no longer opens a run for an item that GitHub no longer has. On `GitHubItemNotFoundError`, `TriggerCondition.holds` returns `false` and the item's queued events are revoked; a failed request or a recheck over five seconds still opens the queued event.
