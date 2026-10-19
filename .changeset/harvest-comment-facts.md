---
"@usine/core": minor
"@usine/executor": minor
"@usine/durable": patch
"@usine/orchestrator": minor
---

`harvestFacts` records the comments and reviews an Attempt posted on its Run's Item as `Comment` facts. It lists the Item's comments and, on a pull request, its reviews and review comments, and keeps those written by the Attempt's bot login since the Worker prepared the checkout. A pending review and its comments are left out. A schedule Run, whose payload names no Item, asks GitHub nothing. A GitHub failure or a ten-second stall keeps the commits and pull requests, records no comment, and logs a warning.

The bot login comes from the RunSpec. When the RunSpec has none, the harvest asks GitHub's GraphQL `viewer` for the login of the Attempt's credential and logs that it did.

A comment now counts as delivered work: an Attempt whose parent's last turn answered the operator, such as a parent the operator released, succeeds when it posted a comment or a review on the Item instead of failing with an `AgentFailure`.

`@usine/core/worker`: `BotLogin`, the `<slug>[bot]` login of the GitHub bot account an Attempt writes as. `@usine/core/step/result`: `Comment` has a `kind`, one of `issue-comment`, `review`, and `review-comment` (`CommentKind`). `@usine/core/attempt/channel`: `RunSpec` has `preparedAt`, when the Worker prepared the Attempt's checkout, and `botLogin`; a RunSpec stored without them decodes with none. `HarvestSpec` also reads the RunSpec's `payload`, `preparedAt`, and `botLogin`.

`@usine/executor`: `CheckoutRequest` has `botLogin`, none by default, and preparation copies it and the preparation time into the Attempt's RunSpec.

`@usine/orchestrator`: the scheduler sets each Attempt's `botLogin`: `<slug>[bot]` from the App's installation on local and SSH Workers, and `exe-dev-github-integration[bot]` on exe.dev Workers. `stepExecutorLayer`, and the local, SSH, and exe.dev engine compositions, now require `GitHubApp`. A failure to read the installation is logged and leaves the login to the harvest's fallback.
