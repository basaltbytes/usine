---
"@usine/core": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/server": patch
---

A CI handoff that names a merged pull request now fails with "pull request #<n> is merged" instead of "is closed". When a detached checkout's head is only on `refs/pull/<n>/head`, harvesting now also requires the pull request's head on GitHub to be that commit. A verified handoff keeps only the open pull requests from the attempt's repository among the others that GitHub's commit-to-pull-request index lists at its head, so a closed pull request at the same head no longer appears in the run's changes.

`harvestFacts` now requires its `handoff` argument, and `StepExecution.requiresCi` and `CheckoutRequest.requiresCi` have no constructor default, so a caller that forgets either value fails to compile. `retryTransient` accepts a refinement and passes `onRetry` the narrowed failure.
