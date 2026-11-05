---
"@usine/engine": minor
"@usine/server": patch
---

Compress ended attempts' SQLite transcripts in background segments while preserving transcript reads, pagination, and late messages. Report sealing failures with attempt diagnostics and skip malformed rows until restart. Require the transcript codec explicitly in SQLite compositions. Create compact runtime backups that omit freed database pages and sync them to disk before reporting success.
