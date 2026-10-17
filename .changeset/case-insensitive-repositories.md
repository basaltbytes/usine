---
"@usine/config": patch
"@usine/orchestrator": patch
---

Repository names compare case-insensitively, as on GitHub: a Loop selector's `repos` resolve against `usine.yaml` and match managed repositories ignoring case, and `usine.yaml` repositories or selector entries that differ only in case are rejected as duplicates. Board lanes match an Item's labels ignoring case, and two lane `label` sources that differ only in case count as the same source.
