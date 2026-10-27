---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
---

The run page shows how many processes the kernel killed for memory in an attempt's container on an SSH worker, and the container's memory limit, under the attempt's outcome (#600). Before, a command that needed more than `memory_mib`, such as Chromium or Vitest during `pnpm test`, was killed while the container kept running, and only the agent saw it.

- Before the release removes an attempt's container, it reads the `oom_kill` count of the container's cgroup from `/sys/fs/cgroup/memory.events`, and counts one more for each start after the kernel killed the container's init, since a start gives the container a new cgroup. A count above zero is recorded through `Sink.outOfMemory`, and a warning logs it as `The kernel killed processes in the container for memory`. A count that can't be read or recorded is logged and doesn't stop the removal.
- `@usine/core/attempt` exports `OutOfMemoryKills`, with `kills` and `memoryMib`, and `Attempt.outOfMemory`. `AttemptChannel.Sink` has `outOfMemory`.
- `RunStore.recordOutOfMemory` stores it in the new `out_of_memory_json` column of `usine_attempts`, and `AttemptView.outOfMemory` returns it, or null.
