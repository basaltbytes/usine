---
"@usine/orchestrator": patch
---

The queued-Event re-check no longer opens a Run for an Item GitHub no longer has. When the fresh snapshot fails with `GitHubItemNotFoundError`, `TriggerCondition.holds` answers `false` and logs it, so the Item's queued Events are revoked as for an Item that stopped matching. A failed request or a re-check that exceeds five seconds still opens the queued Event as before.
