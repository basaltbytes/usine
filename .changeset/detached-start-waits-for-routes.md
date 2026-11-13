---
"@usine/server": patch
---

`usine up --detach`, `usine restart`, and supervised starts wait until the instance serves its setup or runtime routes again. Since the listener opens right after the instance lock, the startup response (HTTP 503 with `Retry-After: 1`) no longer counts as started, so the command returns after setup mode writes `.usine/admin-token`.
