---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": patch
"@usine/orchestrator": minor
"@usine/server": patch
---

Show workers with three consecutive unanswered probes in Needs attention, with their last answer and running attempts. Refresh and clear the warning independently of run-state changes, and open affected runs from the entry.

Add the probe count to worker notices, defaulting older stored notices to one, and add `TranscriptWorkerQuery` to read the latest worker notice even after later session output.
