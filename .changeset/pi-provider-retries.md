---
"@usine/agents": patch
---

A Pi child records each provider retry Pi reports as `ProviderRetrying`, with Pi's error message and the turn's retry count, and records `ProviderRecovered` when Pi gets an answer again, as the Codex and Claude Code children do.
