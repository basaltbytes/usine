---
"@usine/core": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

`@usine/core/step/result`: `Comment` has `at`, when GitHub says the comment was posted: its `created_at` for a conversation or diff comment, its `submitted_at` for a review. `harvestFacts` fills it in. A `Comment` stored without it decodes with none.

`@usine/orchestrator/operator`: `TaskCommentView` replaces `at` with `postedAt`, the comment's own time or null for a fact harvested before it was recorded, and `attemptEndedAt`, when the Attempt that recorded it ended.

The web UI's Task page dates each comment and review by when it was posted, and by its Attempt's end only for one recorded before posting times were; the tooltip says which.
