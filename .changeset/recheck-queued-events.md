---
"@usine/engine": minor
"@usine/orchestrator": minor
---

Re-evaluate a queued Event's trigger before it opens a Run. When the Run ahead of it closes, the engine asks the new `TriggerCondition` port (`@usine/engine/trigger-condition`, required by `layerWithDatabase` and the local SQLite layer) whether the Loop's trigger still matches the Item's current state: an Event that no longer matches is recorded as ignored (revoked) and never opens a Run, one that still matches opens as before and waits for its own approval when the Loop requires one.

The orchestrator's implementation fetches a fresh GitHub snapshot of the Item and evaluates the Loop's trigger against it, so a Run that pushes a commit and only then swaps the labels gating its trigger no longer spawns a second Run from the poll in between. A check that cannot complete keeps the previous behavior and opens the Run.
