---
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
