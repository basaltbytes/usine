---
"@usine/core": minor
"@usine/engine": patch
"@usine/orchestrator": minor
"@usine/server": patch
---

Record accepted CI fixes as neutral handoffs with links to the continuing run. Keep source runs out of failure statistics and Needs attention when a fix run continues the work. Task lists and board cards show the fix run's status. Unavailable fix loops, refused events, exhausted budgets, and CI timeouts still require attention.

Preserve pending completion actions across CI fix runs and apply them with the final successful head’s actions.
