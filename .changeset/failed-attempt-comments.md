---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

An Attempt that fails or is canceled records the comments and reviews it posted on its Run's Item. The engine stores a Step result only when an Attempt succeeds, so these comments live on the Attempt instead of in a Step result.

`@usine/core`: `Attempt` has `comments`, the `Comment` facts of an Attempt that ended without success, empty by default. `AttemptChannel.Sink` has `comments`, which records them. `@usine/core/step/harvest` exports `harvestPostedComments`, which collects only the comments as `harvestFacts` does and records none when GitHub fails or stalls.

`@usine/executor`: once the parent task of a failed, canceled, or runaway Attempt has stopped, the durable session harvests the Attempt's comments in its checkout and sends them to `Sink.comments`. An Attempt left live because this process stops is harvested when its reattachment ends without success. A failure to record them is logged and never changes how the Attempt ended.

`@usine/engine`: `RunStore.recordComments` stores them in the new `comments_json` column of `usine_attempts`, and the Run's Attempts read them back; an Attempt recorded before the column existed reads none.

`@usine/orchestrator`: `TaskView.comments` adds the comments failed and canceled Attempts recorded, and lists a Run's comments newest first, each once.

The web UI's Task page lists the comments and reviews of every ended Attempt, not only succeeded ones.
