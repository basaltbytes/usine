---
"@usine/agents": patch
---

When a Codex app-server has already exited, stopping it no longer logs `Could not force Codex app-server to stop` or `Forcing Codex app-server to stop after graceful shutdown failed` as warnings. A forced stop that fails because the process is gone, or a failed graceful shutdown whose exit code is already known, logs at debug level with the exit code. Both warnings still appear for an app-server that is still running after the forced stop.
