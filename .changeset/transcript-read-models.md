---
"@usine/engine": patch
---

Read transcript usage and pool limits from summaries updated atomically on append, and index worker and session-state reads. Backfill existing transcripts during startup without rebuilding the transcript table.
