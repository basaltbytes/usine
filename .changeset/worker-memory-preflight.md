---
"@usine/executor": patch
"@usine/orchestrator": patch
---

Worker preflight checks the machine's memory against `max_concurrent_attempts`, and `Executor.preflight` takes `maxConcurrentAttempts` as a third argument. Preflight fails with the new `memory` capability below 1.5 GiB per concurrent attempt, or with no swap and more than one concurrent attempt, and warns below 3 GiB per concurrent attempt.
