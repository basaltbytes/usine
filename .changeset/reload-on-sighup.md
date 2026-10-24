---
"@usine/server": patch
---

`usine up` reloads the instance folder on `SIGHUP`, `POST /api/instance/reload`, or **Reload configuration** on the Loops page, including in setup mode, and `SIGHUP` no longer ends the process. A refused reload returns 422 `FactoryConfigError` for an invalid `usine.yaml` or 409 `RestartRequiredError` for a changed `workers` or `webhooks` block.
