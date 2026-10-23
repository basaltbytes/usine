---
"@usine/orchestrator": patch
---

`Operator.detail` caches the token reports of ended attempts in memory until the orchestrator restarts. Each poll from the run page and drawer reads only the running attempt.
