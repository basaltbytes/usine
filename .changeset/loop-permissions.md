---
"@usine/core": minor
"@usine/config": minor
"@usine/engine": minor
"@usine/executor": minor
"@usine/github": minor
"@usine/orchestrator": minor
---

A Loop file can set `permissions: read`, and its Attempts get a GitHub token that cannot push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps today's token.

`@usine/core/loop` adds `LoopPermissions` (`write` or `read`), and `AttemptRecovery` carries the Attempt's level. `@usine/config/loop`: `LoopFile` has `permissions`, parsed from the `permissions` key and `write` when the key is absent.

`@usine/github/github-app`: `GitHubApp.workerToken` takes the level, `SingleRepository` records it, and `WORKER_TOKEN_PERMISSIONS` lists the repository permissions of each level. A `read` token has `contents: read` and keeps `pull_requests: write` and `issues: write`, so a review Loop still posts reviews and comments.

`@usine/engine`: `Submission`, `RunSnapshot`, and `StepExecution` carry `permissions`, and a migration adds `permissions` to `usine_trigger_events`, `write` for every Event recorded before it. A Run keeps the level its Event was submitted with.

`@usine/executor`: `CheckoutRequest` has `loop` and `permissions`, and `CredentialProvider.issue` takes the level. The local and SSH Workers mint the Attempt's token at that level, and a Worker behind a Gateway attaches it. An exe.dev Worker refuses an Attempt of a `read` Loop with a `credentials` `WorkerCapabilityError` before it attaches the integration, because exe.dev's integration cannot grant read-only access. A `read` checkout gets a pre-push hook that stops `git push` with a message naming the Loop, so the Agent reads why instead of GitHub's 403; the token is what refuses the push. A `read` Attempt that ends without success is removed without salvage.

`@usine/orchestrator`: Polling and schedule triggers submit the Loop's level, the scheduler passes it to the executor, and the GitHub credential provider mints at it.
