---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

Show Needs attention warnings when a pool's latest reported rate window reaches 80% and has a future reset. Include the recorded login, percentage, and reset time, with Dismiss and Undo. Clear warnings when a newer report recovers or the window resets, independently of scheduling.

Expose the latest stored snapshot per pool through `RunReader.latestPoolRateLimits()`, with a partial index on the existing transcript table.
