---
"@usine/github": patch
"@usine/orchestrator": patch
---

An open pull request or failing Item that GitHub no longer has no longer stops its repository's poll at every cycle. The poll logs a warning, drops the Item from the cursor, revokes its unstarted Runs as for an Item that stops matching, and continues with the other Items. `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the repository answers without the Item, including when GitHub GraphQL reports it as `NOT_FOUND`; other invalid responses and failed requests still interrupt the cycle.
