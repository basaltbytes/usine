---
"@usine/server": patch
---

A reload resizes, adds, and removes workers, and its response lists the changed workers. A `workers` change that needs a restart returns 409 `RestartRequiredError`, and a new worker or slot that fails preflight returns 409 `ReloadPreflightError`.
