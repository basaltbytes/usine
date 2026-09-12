---
"@usine/core": minor
"@usine/agents": patch
"@usine/engine": patch
"@usine/server": patch
"@usine/executor": patch
"@usine/run-host": patch
"@usine/orchestrator": patch
---

Persist Claude and Codex child sessions and record their native ids and worker paths in transcripts. Show copyable resume commands in the Run drawer, including for completed sessions outside the loaded history page.

Upgrade the orchestrator and run host together for Attempt channel protocol v6. Existing protocol-v3 through v5 transcripts remain readable.
