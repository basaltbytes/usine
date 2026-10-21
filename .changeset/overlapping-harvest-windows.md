---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
---

`harvestFacts` and `harvestPostedComments` leave out a comment or review posted while another Attempt of the same Agent was open on the Run's Item. Two Loops' Runs of one Agent on one pull request write as one bot login and sign alike, so such a comment could be either Attempt's, and neither records it. Each one left out gets an info log line that names the comment and both Attempts, and the harvest's summary line counts them as `ambiguous`. A comment counts from its creation and a review from its submission, so a comment the bot login posted before the Worker prepared the checkout and edited since is no longer recorded; the summary line counts those as `edited`.

`@usine/core`: `@usine/core/attempt` exports `AttemptWindow`, the time an Attempt was at work on its Item according to its record, with `windowOf`, `windowHolds`, and `windowsOverlap`. The Run reader and the harvest both apply this rule. `harvestFacts` and `harvestPostedComments` take `overlapping`, an `OverlappingWindows` read of the windows of the Agent's other Attempts that overlap this Attempt on the Item, and run it once GitHub has listed the comments. When it fails, `harvestFacts` fails with a `HarvestError` at the new `windows` stage, and `harvestPostedComments` records no comment. `AttemptChannel.Sink` and `RecoverySink` have `overlapping`, which reads those windows.

`@usine/engine`: the sink a Run's fiber passes to `StepExecutor.execute`, and the `RecoverySink` that startup reconciliation passes to `StepExecutor.recover`, read the windows from the run tables (`RunStore.overlappingWindows`). An Attempt that ended before end times were recorded has no known window and is not listed.

`@usine/executor`: the durable session passes `Sink.overlapping` to the harvest, which reads the windows once GitHub has listed the comments, not when the Attempt is prepared or before the harvest starts. An Attempt that started later, even while the harvest ran, is therefore included. Startup reconciliation passes `RecoverySink.overlapping` to the harvest of a failed Attempt's comments. If the windows cannot be read, a finished Attempt's harvest fails, and an Attempt that ended without success records no comment.
