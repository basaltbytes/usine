# @usine/github

## 0.6.0

### Minor Changes

- bfa02ef: A CI handoff that names a closed or merged pull request now fails as an agent failure with the new `PullRequestNotOpen` reason. A CI wait whose pull request is merged or closed before CI passes now ends at once, with no completion labels and no fix; before, a pending wait stayed pending until its timeout. A merged pull request ends the wait as passed. A pull request closed without a merge cancels the run with the new cancel reason `PullRequestClosed`, through the new `CiPullRequestClosed` resolution, so it isn't an agent failure. If CI on a merged pull request's head is already green, the wait passes and applies its completion labels. `CheckSnapshot` reports the pull request's state as `pullRequestState`, and reads a null branch target as the pull request's head instead of failing to decode.
  
  Harvesting compares the pull request's head repository with its base repository by ID, so a renamed repository verifies. A verified handoff also keeps the other pull requests that GitHub's commit-to-pull-request index lists at its head. A detached checkout whose head is only on `refs/pull/<n>/head` reads those pull requests by number instead of waiting on the index. A candidate branch or pull request whose read fails no longer hides another candidate's open pull request. GitHub reads now retry invalid output, like failed reads.
  
  Two new reasons separate failures that were all reported as `GitHubReadFailed`: `GitReadFailed` for a failed `git` read of the checkout or origin, and `VerificationTimedOut` for reads that take longer than 10 seconds. Both remain retryable infrastructure failures. `GitHubReadFailed` keeps the read's error as `cause`.
- 2a76a52: Outcome label verification counts only the labels that an attempt's GitHub account added during that attempt, or that an earlier attempt of the same run added during that earlier attempt. Local, SSH, and Cloudflare workers write as the GitHub App's bot, which usine also uses for `on_green` labels, so a label added between two attempts no longer counts for the retry. A timeline of more than ten pages falls back to the current labels without a retry. Other responses that usine can't use, such as a body that fails partway through, are retried like transport failures. `GitHubItemHistory.appChanges` fails with the new `GitHubTimelineTooLongError` for a timeline of more than ten pages.
  
  `Attempt.workerKind` records the kind of the attempt's worker when it starts, and the check reads each attempt's GitHub account from it, so a later change to the worker's kind doesn't change the account. Older attempts have none and use their worker's configured kind. The SQLite store adds a nullable `worker_kind` column to `usine_attempts`. A `StepExecutor` lease (`WorkerLease`) has a required `kind`: the kind of the leased worker.
  
  `FailedAttemptView.report` is the final report that a failed attempt kept, set in run detail reads and null in run lists: the report that the completion check rejected, or the report that handed off to CI before CI failed, timed out, or ended incomplete. The run page and run drawer show it under **Final report**, after the failure.
- 2882f71: A CI wait no longer treats a partially created GitHub Actions run as green or as a failure for the fix loop. Before it applies completion labels or starts a fix, usine reads the latest run of each workflow on the recorded head. When a run concluded `failure` or `cancelled` with no failed job, such as a run whose jobs Actions never created, the wait ends in **Needs attention** as an infrastructure failure that names each run ID and link. usine applies no completion labels and starts no fix. A failed job or failed commit status on the head still starts the fix loop without waiting for other workflow runs, except a gate job that failed only because jobs it needs stayed queued. Before the CI deadline, CI that ran only in part keeps the wait pending while a check outside the concluded runs, such as a commit status, is still pending. If GitHub refuses the commit-status read, such as when the App lacks the optional **Commit statuses: read-only** permission, usine decides from the check runs alone. A job that fails while usine reads CI waits for the next poll. Otherwise, a workflow run that hasn't concluded keeps the wait pending, even after its last job finished and the checks read green, until the CI deadline. usine doesn't rerun workflows, so the App doesn't need **Actions: read and write**; rerun the named runs and apply the completion labels after the checks pass.
  
  `GitHubChecks.workflowRuns` from `@usine/github/checks` returns runs that concluded `failure` or `cancelled` as `FailedWorkflowRun` records and runs that haven't concluded as `RunningWorkflowRun` records. `GitHubChecks.unfinishedChecks` returns the check runs and commit statuses on a head that haven't completed as `UnfinishedCheck` records; when GitHub refuses the commit-status read, it returns the check runs alone, and `CiIncomplete` from `@usine/core/ci` is the CI resolution that settles the wait.
- 589ad7b: `GitHubChecks.pendingDetails` takes a `historyDeadline` and returns a `PendingCheckReport` instead of an array of `PendingCheck` records. The report lists running jobs before queued ones and counts in `omitted` the pending checks after the first ten. When no check run is pending, it lists the head's pending legacy commit statuses. Duration history reads stop at the deadline or at the first rate limit and keep the durations already read, so a slow history read no longer discards the job list. The baseline for a job's previous duration now comes from the latest successful run of the same workflow and event.
  
  The CI timeout diagnostic now reads "has been running for 31 min; its last successful run took 6 min" instead of quoting GitHub's `in_progress` status, states when a running job has no recorded start time, and says how many pending checks it leaves out. When the diagnostic read fails, its warning log includes the failed GitHub operation and message.
- c7f39bc: A CI wait now tells a stalled or incomplete GitHub Actions run apart from red CI, and explains how to recover. At the CI deadline, usine reads the workflow runs on the recorded head even while the checks are pending. If GitHub Actions left a run `queued` or `in_progress`, the timeout message says that Actions didn't finish it and names the run with its ID and link. It tells you to push a commit or to rerun the run once GitHub allows it. A gate job that failed only because jobs it needs stayed queued is incomplete CI, not a failure: the wait ends in **Needs attention** as an infrastructure failure that names the run and the jobs that didn't finish, and it starts no fix. While that run is still going, the wait stays pending, because the queued jobs can still start. usine matches that job by its Actions job ID, so a failed job with the same name in another workflow run, or a failed commit status on the head, still starts the fix loop. A failed job from an earlier attempt of a rerun that is still going keeps the wait pending. When a run is still going or checks are still pending at the deadline, the message also lists the pending jobs with their running times. A run that ran only in part waits while another workflow run on the head is still going, so a later failure in that run still starts the fix loop. At the deadline, the message names every workflow run that didn't run or finish in full.
  
  A run whose CI wait ended this way offers **Apply CI labels** in **Needs attention**. After CI on the same head passes, with every workflow run concluded in full, the action applies the wait's completion labels and marks the failure resolved. While CI on the head hasn't passed, or after the pull request closed without a merge, it applies nothing and shows why. The operator API exposes it as `POST /api/runs/{runId}/apply-ci-labels`, which answers `409` with `CiNotPassedError` until CI passes. When GitHub refuses the workflow-run read, such as on a private repository without **Actions: read-only**, the check state decides alone, as it does during the wait.
  
  `RunState.Failed` from `@usine/core/run/state` keeps the wait's handoff as `unfinishedCi`, and `operatorActions` reports `canApplyCiLabels`. `GitHubChecks.workflowRuns` from `@usine/github/checks` reports the runs that concluded `failure` or `cancelled` as `FailedWorkflowRun` records in `failed`, and lists the jobs of each run's latest attempt as `WorkflowJob` records in `jobs`. `CheckFailureEvidence` now lists `checks` as `FailedCheck` records with their `ActionsJobRef`, and `GitHubChecks.failedStatuses` reads the failed commit statuses on a head. `CiMonitor.applyLabelsAfterGreen` applies the labels, and `RunView.canApplyCiLabels` and `RunFailureNeed.unfinishedCiAttemptId` from `@usine/orchestrator/operator` expose the action.
- 4a83af0: On the task page, **Retry** after a pull request's base or head changed refreshes the task first and then loads the PR's current changes, instead of repeating the stale selection. When every recorded attempt on a pull request pushed no new commits, the **Changes** panel says so instead of reporting that no attempt commits were recorded. Task detail's `attemptChanges` now includes those attempts with a `base` equal to their `head`.
  
  When GitHub answers 404 for a file read because the GitHub App installation doesn't cover the repository, `GET /api/projects/:project/pull-requests/:repository/:item/files` returns `503` with `ProjectNotInstalledError` and says that the App lost access, instead of reporting an unavailable comparison or force push. `GitHubFiles.read` fails with `ProjectNotInstalledError` in that case.
  
  The server cache for pull request files holds up to 64 MiB of file paths and patch text and evicts the least recently read responses first, so responses over 512 KiB are cached too. Concurrent reads of one selection share their GitHub requests.
  
  `@usine/github/files` exports only `GitHubFiles`. Import `ChangedFile`, `FileChanges`, `FileChangesQuery`, `PullRequestFilesQuery`, `CommitRangeFilesQuery`, and `PullRequestFilesChangedError` from `@usine/github/file-changes`.

### Patch Changes

- Updated dependencies [f8f311c]
- Updated dependencies [2b3ac6b]
- Updated dependencies [095438d]
- Updated dependencies [6aa5e72]
- Updated dependencies [539349e]
- Updated dependencies [bfa02ef]
- Updated dependencies [c8ea557]
- Updated dependencies [589ad7b]
- Updated dependencies [e828b51]
- Updated dependencies [d7e00bc]
- Updated dependencies [64afcbb]
- Updated dependencies [fd52df7]
- Updated dependencies [e8003db]
- Updated dependencies [c8241d7]
- Updated dependencies [2a76a52]
- Updated dependencies [360d371]
- Updated dependencies [2882f71]
- Updated dependencies [fa97db3]
- Updated dependencies [c7bd772]
- Updated dependencies [c7f39bc]
- Updated dependencies [324bfed]
- Updated dependencies [738c15c]
- Updated dependencies [1eddd3d]
- Updated dependencies [4aebd77]
  - @usine/core@0.8.0

## 0.5.0

### Minor Changes

- e0cedc8: Classify pending CI deadlines as infrastructure failures and report running jobs with elapsed times and previous successful durations when available. Bound diagnostic reads so a stalled request cannot prevent timeout settlement.
- 6e60662: Brand Schema records and errors so TypeScript callers construct or decode validated values. Compose decoding with Effects and report invalid input through existing operation error channels. Keep formatting helpers pure and treat internal encoding failures as defects. Configuration and HTTP JSON formats remain unchanged.
- a1c0d36: Add durable CI waits for developer and fix loops. Agents can end after pushing, freeing their worker slot while usine observes checks on the recorded head. Green applies recorded labels, red starts a budgeted fix loop with failure diagnostics, and silent checks time out into Needs attention. The run page and board link to the waiting PR's checks.
- 8d28709: Expose operations without arguments as Effect values in engine, GitHub App, and attachment services. Run them with `yield* service.operation`. Backup operations require `FileSystem` and `Path` from the application's platform layer.
  
  Use schema-backed errors and schema predicates, preserve typed failures during selective recovery, and compose services in their owning scopes. Sandbox errors expose `sandbox` in TypeScript while preserving the JSON `name` field.
- 13bdef9: Store optional OAuth client and webhook credentials alongside the App signing key. Add atomic owner-only credential writes and an installation-page lookup that works before the App has an installation.
- 702692b: Refresh older open pull request payloads once to record comparison bases. Omit attempts without new commits, show checks and review decisions only for whole-PR comparisons, and keep file names readable on phones.
  
  Use `scope` for the file-selection query parameter. Return specific 404 errors for unavailable comparisons and 409 errors for stale PR selections. Bound cached file responses to 512 KiB per entry and 64 MiB of serialized payloads, document the conservative 300-file comparison limit, and export file-change models separately from the GitHub service.
- 81330c9: Show whole pull request and recorded attempt changes on task pages with collapsed file diffs, change counts, and CI and review state. Add a project-scoped files API and commit-based caching, with explicit reporting for missing and truncated GitHub patches.
  
  Keep recorded attempt changes available after failed or canceled CI waits, including when a later retry succeeds.
  
  Backfill older comparisons only when their producing attempt is identifiable, and let each attempt's completion replace an existing backfilled result.
  
  Classify generated files by path to avoid marking hand-written files whose patches mention generated-file markers.
- 0e34ec1: Add `outcome_labels` to require a GitHub verdict before an agent completion succeeds, with a fresh labels-only read and a visible failure when the verdict is missing. Retry failed verification reads twice; if verification remains unavailable, require operator attention without rerunning the agent.

### Patch Changes

- 7e39460: Retry transient GitHub polling responses, including CI check and log reads, up to twice with jittered backoff and warning logs. Report GitHub request failures in Needs attention after three consecutive failed repository poll cycles, including deferred snapshots and CI observations for repositories removed from configuration, and clear them after a successful cycle. Preserve failure counts and existing alerts while open-issue checks or label requests are rate-limited. Retry warnings include the operation and error tag, with the response status for HTTP failures.
- c396562: Include failed Actions step names, failure-marker context, and final output in CI fix prompts. Exclude post-job cleanup from failed command output.
- dbf14bb: Recognise GitHub server errors by their schema instead of an `instanceof` check.
- 9786f67: An attempt whose CI pull request can't be verified now fails with the reason in its message. A handed-off head that differs from the checkout, a pull request that origin doesn't have or that comes from another repository, and a branch that isn't at the pushed head are agent failures. A GitHub read that still fails is a retryable infrastructure failure.
  
  The pull request read during harvesting retries twice, on the same schedule as the GitHub polling reads, and logs the branch's commit on origin against the pull request's head on GitHub.
  
  A loop with a CI policy whose agent ends without a handoff now verifies the open pull request of the checkout's branch on origin and uses branches on origin at HEAD for detached checkouts. When only pull request refs match, it uses GitHub's commit-to-pull-request index. An unchanged detached checkout from a branch or tag revision fails as an agent failure instead of waiting on an unrelated pull request.
  
  For a detached fixed-commit checkout, indexed pull requests from a fork now fail with `RepositoryMismatch`. When an origin branch matches the detached HEAD but has no open pull request, verification fails with `PullRequestNotFound` even if a matching pull request ref is also on origin. The commit index is queried only when no origin branch matches.
  
  A plain success whose GitHub or git verification read fails now records an `InfraFailure` instead of an `AgentFailure`. This includes persistent authorization failures such as HTTP 403, so the attempt can run up to three times. A local branch pushed under a different remote name fails with `BranchNotAtHead`; an explicit handoff verifies the pull request's source branch independently of the local branch name.
- 9132a5b: Read completed Actions job logs when the run archive is unavailable, preserving failed-step evidence while other matrix jobs are running.
- f0f018d: Keep polling a repository when GitHub returns a server error for one item's snapshot: log a warning, commit the other items and the poll cursor, and fetch that item again in the next poll. A cycle budget reset now fetches only its item instead of polling the whole repository from scratch.
- 5796627: Verify explicit CI handoffs against the pushed origin branch when GitHub's pull request head is stale. Keep CI pending until the PR head catches up, and classify unverified handoffs as retryable infrastructure failures.
- 1d5414f: Route a pull request with merge conflicts and no checks to the configured CI fix loop. The fix task includes conflict resolution instructions and inherits pending completion actions. Unknown mergeability keeps the CI wait pending.
- 8412ddc: Use Effect services for platform operations and deterministic service keys. Report worker JSON encoding failures as defects and preserve synchronous formatting and validation boundaries. Gateway composition supplies Crypto for auth-file names. Check all configured Effect diagnostics directly with the patched compiler.
- 765be2e: Request Workflows write permission for write-access attempts so they can push changes under `.github/workflows/`. The GitHub App setup requests the permission, and installation checks report a missing grant. Existing App installations must accept the permission update. Read-access tokens continue to omit Workflows.
- Updated dependencies [6a1cf79]
- Updated dependencies [e0cedc8]
- Updated dependencies [6e60662]
- Updated dependencies [01467e3]
- Updated dependencies [a1c0d36]
- Updated dependencies [e007d09]
- Updated dependencies [9290433]
- Updated dependencies [1c981c9]
- Updated dependencies [82b55aa]
- Updated dependencies [9786f67]
- Updated dependencies [7e5bb5b]
- Updated dependencies [d740598]
- Updated dependencies [bb96f16]
- Updated dependencies [4f87593]
- Updated dependencies [77ede43]
- Updated dependencies [6316707]
- Updated dependencies [5796627]
- Updated dependencies [4d60236]
- Updated dependencies [9476883]
- Updated dependencies [10154eb]
- Updated dependencies [7c58461]
- Updated dependencies [1948b10]
- Updated dependencies [9cf0b5e]
- Updated dependencies [9e30c8c]
- Updated dependencies [69ba086]
- Updated dependencies [8412ddc]
- Updated dependencies [d0900a3]
- Updated dependencies [81330c9]
- Updated dependencies [0e34ec1]
- Updated dependencies [d0900a3]
  - @usine/core@0.7.0

## 0.4.0

### Minor Changes

- fdecd7e: Add schema validation for configuration form drafts and API endpoints for supported harnesses, efforts, installation repositories, and live repository labels.
- e59f7b8: Add `GitHubApp.configureWebhook(url)` to configure the App webhook delivery URL and JSON content type with App JWT authentication.
- 4144c5f: Preserve GitHub's 64-bit webhook delivery IDs when decoding summaries, filtering newer deliveries, and saving cursors. `WebhookDeliveryId` now accepts decimal strings instead of numbers; compare IDs with `BigInt`. Existing numeric cursors reset once and subsequent polls store exact strings.
- 1c1e516: Expose the latest label-addition actor and time for current issue and pull request labels through `item.labelEvents`. Loop conditions can use this history to select App-set labels for approval.
- 5e4644e: Add webhook deliveries mode to refresh managed repositories about every 10 seconds using GitHub App delivery summaries. Persist the delivery cursor across restarts, preserve the normal polling cadence, and show the last received hint in Settings.

### Patch Changes

- d64b7c3: Document public API credentials, token scopes, polling results, item history, and service operations in TSDoc.
- 8e49188: Show exe.dev attempts' GitHub label changes, comments, and reviews in the run reader. Match each attempt against its worker's bot identity and preserve operator board moves under the instance App.
  
  Recompute cached attribution when the configured worker identities change, including workers used by overlapping attempts.
  
  `GitHubItemHistory.appChanges` now requires the writer's `BotLogin` as its fourth argument, and `Operator.githubChanges` takes the current instance before the run ID. Removed workers have unknown writers, so the reader logs and omits their agent changes. exe.dev VMs share an integration bot; another VM's writes in the same attempt window can be attributed to the attempt.
- Updated dependencies [d1fd769]
- Updated dependencies [6541e90]
- Updated dependencies [6d7f66f]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0

## 0.3.0

### Minor Changes

- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)).
- dfd0936: Polling fetches an open pull request again only when change detection reports it, its base branch head moved or can't be read, or its `mergeable` is `UNKNOWN`, instead of on every poll. Each poll reads each base branch head with one conditional request. `GitHubPolling` adds `baseRefHead`, `@usine/github/polling` exports `BaseRefName` and `BaseRefHead`, and `PullRequestPayload.baseRefName` is a `BaseRefName`.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- d819599: Attempts commit as the GitHub App's bot account on every worker kind. Before, a local worker's commits took the identity in the operator's global git config, unless the agent passed one itself.
  
  `@usine/core/worker` adds `BotAccount`, a bot's `BotLogin` and `BotUserId`, with its ID-based noreply address in `noreplyEmail`. `GitHubApp.botAccount()` returns the App's bot account, read from `GET /users/<slug>[bot]` once per App slug; the bot's user ID differs from the App ID.
  
  `CheckoutRequest` requires `commitAuthor`. The local, SSH, and exe.dev executors set it as `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL`, `GIT_COMMITTER_NAME`, and `GIT_COMMITTER_EMAIL` in the parent's and children's environment, which git prefers to `user.name` and `user.email` in any config. The values aren't secret, so remote workers export them in the command line and the machine's sshd needs no `AcceptEnv` change.
  
  The scheduler reads the bot account for each attempt and sets both `commitAuthor` and, on local and SSH workers, `botLogin` from it. If the account can't be read, the attempt fails before preparation: with an infrastructure failure, which is retried, or without a retry if GitHub refused, for example because the App has no installation.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/core@0.5.0

## 0.2.0

### Minor Changes

- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- cef956c: Adds `GitHubItemHistory.appChanges(repository, item, since)` to `@usine/github/item-history`, which returns the App's label changes, comments, and reviews on an item as `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`; `Installation` adds `appSlug`. `Operator.githubChanges(runId)` returns each attempt's changes as `RunGitHubChangesView` at `GET /api/runs/:runId/github-changes`, which returns 404 `GitHubItemNotFoundError` for an item that GitHub no longer has.
  
  The run page shows each label change, comment, and review that an agent made on the item where it happened.

### Patch Changes

- ca2e7a5: `GitHubApp` errors include GitHub's reason, and `isRefusal` tells a definite refusal from an unsent request, server error, or rate limit.
- 291d428: Adds `GitHubPolling.missingIssues(repository, numbers)`: the issue numbers GitHub no longer has, 50 per GraphQL request.
- 564449d: An open pull request or failing item that GitHub no longer has no longer stops its repository's poll. The poll logs a warning, drops the item from the cursor, and revokes its unstarted runs; `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the item is missing or GraphQL reports `NOT_FOUND`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5870baf]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [6764fa7]
- Updated dependencies [466e711]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [d933ab6]
- Updated dependencies [a3a230c]
  - @usine/core@0.4.0

## 0.1.2

### Patch Changes

- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0

## 0.1.1

### Patch Changes

- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- 4c97cae: Accepts installation tokens when GitHub's clock is slightly ahead, without extending the local lease past one hour.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [a36f46e]
- Updated dependencies [333eacd]
- Updated dependencies [bd45cf4]
- Updated dependencies [e7adbd8]
- Updated dependencies [57a374f]
  - @usine/core@0.2.0

## 0.1.0

### Minor Changes

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 57d383b: Adds GitHub App authentication, installation discovery, per-project installation coverage, local credential loading (mode 0600), and single-repository worker tokens.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [27004c2]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [3041f9d]
  - @usine/core@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
