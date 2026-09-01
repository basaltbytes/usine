---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Add CLI port overrides, help and version output, occupied-port diagnostics, and a two-second timeout when `usine up` opens the setup page. The operator API now returns attempts, needs, and transcript events without exposing infrastructure causes. Cold and live transcript reads have explicit response limits, and the web drawer can continue loading rows beyond its initial 500-row page. Concurrent overview requests reuse one projection computation, and local-worker polling budgets include their timing rationale.
