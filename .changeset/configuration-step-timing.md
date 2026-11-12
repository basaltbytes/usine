---
"@usine/orchestrator": minor
"@usine/server": patch
---

A configuration save or reload logs `Configuration step finished` with the duration and outcome of each step, from waiting for a running save to applying the revision. The coordinator brain check runs once for each distinct parent model and effort, and a check that doesn't finish within 10 seconds refuses the save with `ValidationTimeoutError` (HTTP 503) and stores no revision. `usine config` commands that write a revision apply the same limit. `@usine/orchestrator/current-instance` exports `ValidationTimeoutError`, `coordinatorBrainTimeout`, and `checkCoordinatorBrains`, and `@usine/orchestrator/operator/http` exports `ValidationTimeoutRefusal`.
