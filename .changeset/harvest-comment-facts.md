---
"@usine/core": minor
"@usine/executor": minor
"@usine/durable": patch
---

`harvestFacts` records the comments and reviews an Attempt posted on its Run's Item as `Comment` facts. It asks GitHub for the login of the Attempt's own credential with the GraphQL `viewer` query, then lists the Item's comments and, on a pull request, its reviews and review comments, and keeps those written by that login since the Worker prepared the checkout. A pending review and its comments are left out. A schedule Run, whose payload names no Item, asks GitHub nothing. A GitHub failure or a ten-second stall keeps the commits and pull requests, records no comment, and logs a warning.

A comment now counts as delivered work: an Attempt whose parent's last turn answered the operator, such as a parent the operator released, succeeds when it posted a comment or a review on the Item instead of failing with an `AgentFailure`.

`@usine/core/step/result`: `Comment` has a `kind`, one of `issue-comment`, `review`, and `review-comment` (`CommentKind`). `@usine/core/attempt/channel`: `RunSpec` has `preparedAt`, when the Worker prepared the Attempt's checkout; a RunSpec stored without it decodes with none, and its Attempt's comments are not collected. `HarvestSpec` also reads the RunSpec's `payload` and `preparedAt`.

`@usine/executor`: preparation records `preparedAt` in the Attempt's RunSpec.
