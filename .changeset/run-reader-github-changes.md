---
"@usine/github": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

`@usine/github/item-history` adds `GitHubItemHistory.appChanges(repository, item, since)`, which reads an issue's or pull request's GraphQL timeline and returns the labels the factory's App added and removed, its comments, and its submitted reviews: `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`. `Installation` gains `appSlug`, the App's bot login in GraphQL.

`Operator.githubChanges(runId)` in `@usine/orchestrator/operator` returns `RunGitHubChangesView`: each Attempt's changes on the Run's Item, kept to the App's changes recorded while that Attempt was at work and to no other Attempt on the Item. Ended Attempts are cached in memory. The operator API serves it at `GET /api/runs/:runId/github-changes`, and an Item GitHub no longer has answers 404 `GitHubItemNotFoundError`.

The Run page shows each label change, comment, and review an Agent made on the Run's Item as one line where it happened, under the fold of the calls that made it, with labels in their GitHub colors and comments and reviews linked.
