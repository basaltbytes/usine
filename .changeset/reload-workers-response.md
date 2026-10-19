---
"@usine/server": patch
---

A reload resizes, adds, and removes Workers, and the response of an accepted reload names the Workers it added, removed, or changed. A `workers` change that only a restart applies answers 409 `RestartRequiredError` with a message that names the field, and a Worker or slot count the reload adds that fails Worker preflight answers 409 `ReloadPreflightError`.
