---
"@usine/server": patch
---

`usine up` holds the instance folder through `.usine/instance.lock` from startup until every store has closed. A second `usine up` in the same folder, for example while the first one drains its Attempts, exits with a nonzero status before it opens any store, and names the running process from `.usine/instance.pid`.
