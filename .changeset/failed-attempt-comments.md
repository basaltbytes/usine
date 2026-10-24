---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.

Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
