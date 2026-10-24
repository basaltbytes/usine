---
"@usine/github": minor
"@usine/config": minor
"@usine/orchestrator": minor
---

Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
