---
"@usine/executor": patch
---

An Attempt that starts while its Worker is silent gets `WorkerUnresponsive` as it joins the liveness watch, instead of at the next probe that gets no answer.
