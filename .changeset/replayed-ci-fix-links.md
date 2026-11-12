---
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

A failed run in **Needs attention** says where its CI fix run stands: the fix run continues the work, finished it, handed it to another fix run, or failed too. A reopening or run-again of a fix event now counts as the source run's fix. When two fix runs opened at the same time, the one with the greater run ID is the newest.

The fix run is no longer part of a failed run's attention revision, so a dismissed failure stays dismissed when its fix run opens or changes state. This changes the revision of every failed run once: failures dismissed before this upgrade appear in **Needs attention** again once, and dismissing them again keeps them dismissed.

After a cycle budget reset that replays CI fixes, the web app shows a notice with the number of replayed fixes.

A queued event stores its generated CI handoff instructions apart from its prompt, in a new `ci_instructions` column of `usine_trigger_events` that a migration adds. A recheck removes exactly the recorded instructions before it appends the current CI policy's, so a change to the instructions' wording no longer leaves two handoff instructions in the task. Events queued before this upgrade fall back to removing the instructions that their CI policy generates now.

Breaking API changes:

- `RunReader.ciFixRuns` returns a map from source run ID to `CiFixRun`, which holds the fix run's `runId` and `state`, instead of a map to the fix run ID.
- `RunFailureNeed.fixRunId` is replaced by `fixRun`, a `CiFixRun` or null. Clients of `GET /api/overview` read `fixRun.runId` and `fixRun.state`.
- `Submission` has a `ciInstructions` field, and `AdmissionSettings` includes it. A `TriggerCondition` that returns its own settings sets `ciInstructions` to the instructions that end its `task`, or `None`.
