---
"@usine/executor": patch
---

Preserve SSH attempt harness homes across orchestrator stops while their checkouts remain, so children can resume saved sessions after restart. Remove homes after checkout cleanup or during the startup sweep when their checkouts are gone.
