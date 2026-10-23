---
"@usine/server": patch
"@usine/orchestrator": patch
---

Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
