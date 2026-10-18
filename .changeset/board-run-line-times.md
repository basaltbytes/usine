---
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

Attempts record when they end: `Attempt.endedAt` in `@usine/core`, a migration adding `ended_at` to `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have none.

The Board shows the labels and Item states of each lane under its name, labels in their GitHub colors. A card shows a Run only while the Run is open or failed and not yet resolved. Its time counts from when the Run opened while it is `Waiting` or `Queued`, from when its current Attempt started while it is `Running`, and from the failure once it is `Failed`, and its tooltip gives the full timestamp. The card menu lists only the actions that apply to the card.
