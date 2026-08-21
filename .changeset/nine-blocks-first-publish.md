---
"@usine/core": patch
"@usine/expression": patch
"@usine/loop-file": patch
"@usine/github": patch
"@usine/engine": patch
"@usine/agents": patch
"@usine/executor": patch
"@usine/orchestrator": patch
"@usine/run-host": patch
---

First publish of the nine usine blocks. `@usine/core` ships the Event → Run → Step → Attempt domain model: branded ids, the typestate run state machine (pending → waiting → running → succeeded / failed / canceled), and the attempt-failure taxonomy (infra / agent / runaway) with the auto-retry law. The other eight blocks reserve their seams while the engine grows.
