---
"@usine/engine": patch
"@usine/server": patch
---

Release completed API response bodies retained by SQLite's prepared-statement cache. Preserve SQL trace relationships while preventing cached lookup fibers from retaining request spans.
