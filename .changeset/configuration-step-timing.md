---
"@usine/orchestrator": minor
"@usine/server": patch
---

A configuration save or reload logs `Configuration step finished` with the duration and outcome of each step, from waiting for a running save to applying the revision. The 10-second limit covers the whole coordinator brain check, and a check that doesn't finish in time refuses the save with `ValidationTimeoutError` (HTTP 503) and stores no revision. `usine config` commands that write a revision apply the same limit. `@usine/orchestrator/current-instance` exports `ValidationTimeoutError`, `coordinatorBrainTimeout`, and `checkCoordinatorBrains`, and `@usine/orchestrator/operator/http` exports `ValidationTimeoutRefusal`.
