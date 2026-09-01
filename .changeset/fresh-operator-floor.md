---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Add CLI port overrides, help and version output, occupied-port diagnostics, and setup-page opening for `usine up`. The operator API now returns structured attempts, needs, and transcript events; the web drawer can load transcript rows older than its initial 500-row page. Concurrent overview requests reuse one projection computation, and local-worker polling budgets include their timing rationale.
