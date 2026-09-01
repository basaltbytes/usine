---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/run-host": patch
"@usine/server": minor
---

Add `usine up` with a local observe-and-intervene UI. Persist Loop pause state in the runtime database; list Runs and project protocol-v2 transcripts; expose approve, retry, cancel, pause, and unpause through the embeddable orchestrator; preserve durable observation while the foreground server waits for missing GitHub App credentials with trigger execution idle; and defer loading the real agent runtime until a run host needs it.
