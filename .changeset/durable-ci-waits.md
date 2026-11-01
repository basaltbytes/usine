---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/agents": patch
"@usine/server": minor
---

Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
