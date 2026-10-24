---
"@usine/orchestrator": minor
---

An accepted reload starts the next poll cycle at once, but still waits for a time GitHub asked for, such as a rate-limit reset. If the reload adds a brain that no running agent has, it preflights that brain on every worker first, and a failure rejects the reload with the new `ReloadPreflightError`, which names the agents.

`CurrentInstance` adds `changes`, a stream of snapshots, and `registerPreflight`, which `stepExecutorLayer` calls with its worker preflight. `PollingTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance.
