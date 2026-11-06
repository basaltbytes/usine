---
"@usine/agents": minor
---

Add the Node `child-host/owner` API and use one process owner for Claude Code and Codex. Remote children reattach across SSH loss and orderly restart, with a two-minute orchestrator lease and bounded exit diagnostics. Local children terminate their process groups when the orchestrator pipe closes, including after a crash.
