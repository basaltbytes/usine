---
"@usine/engine": minor
---

The run store records when a run closes: `usine_runs.closed_at` is set when a run succeeds, fails, or is canceled, even before any attempt began, and cleared when a retry reopens it. `RunSummary` and `RunSnapshot` in `@usine/engine/run-reader` carry it as `closedAt`, none while the run is open. The migration dates runs closed before it by the end of their last attempt, else that attempt's start, else when they opened. `RunReader.closed` orders settled runs by the recorded close, so a run canceled after waiting days counts from the cancel. Code that constructs `RunSummary` or `RunSnapshot` adds the field.
