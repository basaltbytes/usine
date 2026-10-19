---
"@usine/engine": patch
---

Depend on `drizzle-orm` 1.0.0-rc.5-5935859, whose Effect integration works with the `effect` version these packages pin. The workspace patched `drizzle-orm` 1.0.0-rc.4 for that, and a plain install did not get the patch, so `@usine/engine/local-sqlite`, `usine backup`, and `usine export-run` failed with `Schema.TaggedErrorClass is not a function`.
