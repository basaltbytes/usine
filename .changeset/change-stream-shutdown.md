---
"@usine/server": patch
---

When the server stops, it ends open `GET /api/changes` streams before it closes its database. A stream that is open during a restart no longer checks its credential against the closed database, so the shutdown no longer logs `Member store operation failed` at `ERROR`.
