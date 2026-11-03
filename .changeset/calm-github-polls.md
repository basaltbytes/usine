---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Retry transient GitHub polling responses up to twice with jittered backoff and warning logs. Report GitHub request failures in Needs attention after three consecutive failed repository poll cycles, and clear them after a successful cycle.
