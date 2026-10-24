---
"@usine/executor": patch
---

An attempt that starts while its worker is silent gets `WorkerUnresponsive` at once, not at the next unanswered probe.
