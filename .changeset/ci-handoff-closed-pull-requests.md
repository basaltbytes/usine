---
"@usine/core": minor
"@usine/github": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

A CI handoff that names a closed or merged pull request now fails as an agent failure with the new `PullRequestNotOpen` reason. A CI wait whose pull request is merged or closed before CI passes now ends at once, with no completion labels and no fix; before, a pending wait stayed pending until its timeout. A merged pull request ends the wait as passed. A pull request closed without a merge cancels the run with the new cancel reason `PullRequestClosed`, through the new `CiPullRequestClosed` resolution, so it isn't an agent failure. If CI on a merged pull request's head is already green, the wait passes and applies its completion labels. `CheckSnapshot` reports the pull request's state as `pullRequest`, and reads a null branch target as the pull request's head instead of failing to decode.

Harvesting compares the pull request's head repository with its base repository by ID, so a renamed repository verifies. A verified handoff also keeps the other pull requests that GitHub's commit-to-pull-request index lists at its head. A detached checkout whose head is only on `refs/pull/<n>/head` reads those pull requests by number instead of waiting on the index. A candidate branch or pull request whose read fails no longer hides another candidate's open pull request. GitHub reads now retry invalid output, like failed reads.

Two new reasons separate failures that were all reported as `GitHubReadFailed`: `GitReadFailed` for a failed `git` read of the checkout or origin, and `VerificationTimedOut` for reads that take longer than 10 seconds. Both remain retryable infrastructure failures. `GitHubReadFailed` keeps the read's error as `cause`.
