---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
---

`harvestFacts` and `harvestPostedComments` leave out a comment or review that could belong to another attempt: one posted while another attempt of the same agent was open on the item, one posted after the attempt's window ended, or one created before the checkout was prepared and edited since. The harvest summary counts these as `ambiguous`, `outside`, and `edited`.

`@usine/core/attempt` exports `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, and `AttemptWindows`. The harvest functions take `windows`, an `AttemptWindowsRead`, and `harvestFacts` fails with a `HarvestError` at the new `windows` stage if the read fails; `AttemptChannel.Sink` and `RecoverySink` add `windows`, which the engine reads with `RunStore.attemptWindows`.
