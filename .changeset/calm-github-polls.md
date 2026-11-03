---
"@usine/github": patch
"@usine/orchestrator": patch
"@usine/server": patch
---

Retry transient GitHub polling responses up to twice with jittered backoff and warning logs. Report GitHub request failures in Needs attention after three consecutive failed repository poll cycles, including deferred snapshots and CI observations for repositories removed from configuration, and clear them after a successful cycle. Preserve failure counts and existing alerts while open-issue checks or label requests are rate-limited.
