---
"@usine/engine": minor
---

The run store records when a run closes in `usine_runs.closed_at`, and clears it when a retry reopens the run. `RunSummary` and `RunSnapshot` in `@usine/engine/run-reader` add `closedAt`, and `RunReader.closed` orders runs by it; add the field to code that constructs `RunSummary` or `RunSnapshot`.
