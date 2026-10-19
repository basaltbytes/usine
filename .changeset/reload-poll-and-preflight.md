---
"@usine/orchestrator": minor
---

An accepted reload starts the next poll cycle at once instead of after the current `poll_interval` wait, and still waits for a time GitHub asked for, such as a rate-limit reset. A reload whose Agents have a brain that no running Agent has preflights that brain on every Worker before it replaces the snapshot; a failure rejects the reload with the new `ReloadPreflightError`, which names the Agents, and keeps the running snapshot. `CurrentInstance` adds `changes`, a stream of the current snapshot and of each accepted reload's, and `registerPreflight`, which `stepExecutorLayer` calls with its Worker preflight. `PollingTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance. At startup, `stepExecutorLayer` preflights the current instance's Agents along with the `brains` it receives.
