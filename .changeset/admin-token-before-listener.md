---
"@usine/server": patch
---

`usine up` writes `.usine/admin-token` before its listener opens. Since the listener opens right after the instance lock, `usine up --detach` could return before the token existed, and a CLI command run right after it failed to read the token.
