---
"@usine/engine": minor
"@usine/orchestrator": patch
---

`RunReader.closed({ limit })` returns the `limit` most recently closed runs, newest first, regardless of when they opened. The overview's **Last outcomes** uses it, so it lists a run that opened long ago and closed recently.
