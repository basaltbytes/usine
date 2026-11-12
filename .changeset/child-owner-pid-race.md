---
"@usine/agents": patch
---

A child process owner relay no longer crashes when the harness exits while the relay checks its PID file. The relay reported the owner as gone only after it read the file, so a harness that exited between those reads could leave the session reporting a failed shutdown.
