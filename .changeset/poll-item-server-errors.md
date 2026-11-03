---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Keep polling a repository when GitHub returns a server error for one item's snapshot: log a warning, commit the other items and the poll cursor, and fetch that item again in the next poll. A cycle budget reset now fetches only its item instead of polling the whole repository from scratch.
