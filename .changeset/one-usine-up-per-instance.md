---
"@usine/server": patch
---

`usine up` locks the instance folder with `.usine/instance.lock` until every store closes. A second `usine up` in the same folder exits with a nonzero status before it opens any store and shows the running process from `.usine/instance.pid`.
