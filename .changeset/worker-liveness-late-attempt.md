---
"@usine/executor": patch
---

An attempt that joins a silent worker's liveness watch gets `WorkerUnresponsive` at the next unanswered probe, and gets `WorkerResponsive` only after a `WorkerUnresponsive`.
