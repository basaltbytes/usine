---
"@usine/executor": patch
---

Restore child holds in the runaway guard after an orchestrator restart so supervised time stays excluded from the wall-clock limit.
