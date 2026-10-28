---
"@usine/orchestrator": patch
"@usine/server": patch
---

Start with healthy workers when another worker fails preflight. Exclude failed workers from scheduling, show their messages in Needs attention, and retry with backoff until they recover. Startup still fails if every worker fails, and live reload still refuses revisions whose preflight fails.
