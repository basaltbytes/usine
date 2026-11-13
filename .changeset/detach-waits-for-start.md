---
"@usine/server": patch
---

`usine up --detach` and `usine restart` return only when the new process has started: migrations are applied, configuration is loaded, the admin token is written, and either setup mode serves its routes or runtime startup begins its worker checks and attempt recovery. A start that fails before that point, such as a failed migration, now makes the command fail with the process exit and the last log lines. Until the instance has started, the listener returns HTTP 503 with `Retry-After: 1` for every request, including `GET /api/version`, and startup responses close the connection.
