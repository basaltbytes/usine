---
"@usine/config": patch
"@usine/server": patch
---

Record configuration revision positions only for workers, relative to the worker list. Adding or removing an entity no longer adds unrelated entities to the revision or their `usine config log` history. Preserve worker order when importing and replaying revisions.
