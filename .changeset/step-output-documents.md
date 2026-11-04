---
"@usine/core": minor
"@usine/agents": minor
"@usine/durable": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Collect typed JSON step outputs from attempt checkouts, preserve them across restarts, and store gzip bodies separately from run results. Run evidence includes output refs. Output collection enforces file-size, count, envelope, and pinned-commit limits, and excludes `.usine/` from commits and salvage.
