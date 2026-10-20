---
"@usine/executor": patch
---

An Attempt that joins a Worker's liveness watch while the Worker is silent gets `WorkerUnresponsive` at the next probe that still gets no answer, and gets `WorkerResponsive` only after a `WorkerUnresponsive` it got.
