---
"@usine/server": patch
---

`usine up` reloads the instance folder on `SIGHUP`, on `POST /api/instance/reload`, and on **Reload configuration** in the Loops page, in setup mode too. `SIGHUP` no longer ends the process. A refused reload answers 422 `FactoryConfigError` for an invalid `usine.yaml` and 409 `RestartRequiredError` for a changed `workers` or `webhooks` block. The shutdown drain reads `max_attempt_minutes` when it starts, so a reloaded value applies to it.
