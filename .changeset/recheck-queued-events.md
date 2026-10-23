---
"@usine/engine": minor
"@usine/orchestrator": minor
---

Before a queued event opens a run, the engine rechecks whether the loop's trigger still matches the item through the new `TriggerCondition` port (`@usine/engine/trigger-condition`), which `layerWithDatabase` and the local SQLite layer require. An event that no longer matches is revoked, and a check that can't complete opens the run as before.

The orchestrator rechecks against a fresh GitHub snapshot, so a run that pushes a commit and then swaps its trigger labels no longer starts a second run.
