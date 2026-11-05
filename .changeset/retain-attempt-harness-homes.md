---
"@usine/executor": patch
---

Preserve SSH attempt Codex homes across orchestrator stops while their checkouts remain, so Codex children can resume saved threads after restart. Remove homes after checkout cleanup or during the startup sweep when their checkouts are gone.
