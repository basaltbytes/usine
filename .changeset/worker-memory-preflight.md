---
"@usine/executor": patch
"@usine/orchestrator": patch
---

Worker preflight checks the memory of the Worker's machine against `max_concurrent_attempts`. `Executor.preflight` takes the Worker's `maxConcurrentAttempts` as a third argument, and the scheduler passes the value from `usine.yaml`. Preflight fails with the new `memory` capability when the machine has less than 1.5 GiB per concurrent Attempt, or no swap and more than one concurrent Attempt, and logs a warning below 3 GiB per concurrent Attempt. SSH and exe.dev Workers, and local Workers on Linux, read `/proc/meminfo`; a local Worker on macOS reads the physical memory and counts swap as present.
