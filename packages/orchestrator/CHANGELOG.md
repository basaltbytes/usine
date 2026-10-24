# @usine/orchestrator

## 0.3.0

### Minor Changes

- d866d8f: Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.
  
  Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- f060b57: Removes `updatedAt` from `BoardTaskView` in `@usine/orchestrator/operator`. Remove the field from code that constructs a `BoardTaskView`.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- a386108: Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.
  
  On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- 56ce81e: Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.
  
  `@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
- 0799f4f: The exe.dev worker runs its Pi parent in the orchestrator as a durable task and its Claude Code and Codex children on the VM over SSH, so an exe.dev attempt reattaches after an orchestrator restart instead of failing. A Pi brain is unavailable on exe.dev.
  
  `@usine/executor/exe-dev` requires an `AttemptRuntime` and no longer launches the run host: it removes `ExeDevExecutorOptions.runHost`, `RunHostCommand`, and the `run-host` worker capability, and `ExeDevExecutorOptions.ssh` takes an `SshCommand` from `@usine/agents/child-host`. Preflight runs the `@usine/agents/preflight` checks on the VM over SSH, and the `@usine/orchestrator/exe-dev` `layer` requires an `AttemptRuntime`.
- 31137ed: The executor opens and maintains its own SSH forward to each gateway's admin API (#249). In `@usine/config/factory`, `gateway.destination` and `gateway.admin_port` replace the admin API URL.
  
  `@usine/core/worker` adds `GatewayAdminPort`, `SshWorkerGateway` in `@usine/executor/ssh` takes `destination` and `adminPort` instead of `adminUrl`, and `sshWorkerAddressesOf(config)` in `@usine/orchestrator/ssh` passes both to the executor. The executor restarts a closed forward with a backoff from one second to one minute, sends a failed admin request once more through a reopened forward, and checks at preflight that the forward opens.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 91e2b70: A loop file can set `permissions: read` to give its attempts a GitHub token that can't push (ADR 0011, amendment of 2026-10-19). The default, `write`, keeps the current token, and a `read` token keeps `pull_requests: write` and `issues: write`, so review loops still post.
  
  Adds `LoopPermissions` to `@usine/core/loop`, `LoopFile.permissions` to `@usine/config/loop`, and a permission level to `GitHubApp.workerToken`, `CheckoutRequest`, `CredentialProvider.issue`, and the engine's run records; a migration adds `permissions` to `usine_trigger_events`, with `write` for existing events. An exe.dev worker refuses `read` attempts with a `credentials` `WorkerCapabilityError`, a `read` checkout gets a pre-push hook that explains the refusal, and a failed `read` attempt is removed without salvage.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 562ba5f: Adds `mergeable` and `mergeStateStatus` to the pull request payload for `pr` triggers and prompts, and the board marks conflicting pull requests. Each poll refreshes known open pull requests, so base changes and late mergeability results update the board and trigger loops.
- 99164fa: The local worker runs its Pi parent in the orchestrator as a durable task, and a live attempt reattaches after an orchestrator restart instead of failing.
  
  `@usine/executor/local` requires an `AttemptRuntime`, drops `LocalExecutorOptions.runHost`, probes harnesses with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the parent task only the attempt's allowlisted environment. Adds `Executor.isLive`, `CheckoutRequest.reattach`, `StepExecutor.isLive`, `StepExecution.reattach`, `AttemptRecovery.open`, and `@usine/core/step/harvest`; `RunStore.beginAttempt` takes the run's live attempt id and can reattach it without spending a retry. The orchestrator's local `layer` requires the `AttemptRuntime`, and `runtimeLayer` provides `@usine/durable/live` on the instance directory.
- 3088f0e: Before a queued event opens a run, the engine rechecks whether the loop's trigger still matches the item through the new `TriggerCondition` port (`@usine/engine/trigger-condition`), which `layerWithDatabase` and the local SQLite layer require. An event that no longer matches is revoked, and a check that can't complete opens the run as before.
  
  The orchestrator rechecks against a fresh GitHub snapshot, so a run that pushes a commit and then swaps its trigger labels no longer starts a second run.
- 39f8d4b: Loops, agents, and the `labels`, `repos`, `settings`, and `operator` keys of `usine.yaml` reload without a restart; new runs use the new configuration, and an open run keeps its agent. An invalid `usine.yaml` fails the reload with `FactoryConfigError`, a changed `workers` or `webhooks` block fails it with `RestartRequiredError`, and both keep the running configuration.
  
  `@usine/orchestrator/current-instance` exports `CurrentInstance`, whose `reload` returns an `InstanceReload` of what changed, and the operator API adds `POST /api/instance/reload`. `Orchestrator.run`, `PollingTriggers.run(current)`, `ScheduleTriggers.run(current)`, `runtimeLayer(instanceDirectory)`, `triggerConditionLayer`, `gitHubCredentialLayer`, and the worker layers read the instance through `CurrentInstance` instead of taking a loaded instance.
- 419bbd7: An accepted reload starts the next poll cycle at once, but still waits for a time GitHub asked for, such as a rate-limit reset. If the reload adds a brain that no running agent has, it preflights that brain on every worker first, and a failure rejects the reload with the new `ReloadPreflightError`, which names the agents.
  
  `CurrentInstance` adds `changes`, a stream of snapshots, and `registerPreflight`, which `stepExecutorLayer` calls with its worker preflight. `PollingTriggers.run` takes the `get` and `changes` of a `CurrentInstance` instead of an effect that reads the instance.
- af28e0e: A refused `POST /api/instance/reload` returns the refusal's typed fields with `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). The Configuration section lists what the refusal names, each linked to its page.
  
  `@usine/orchestrator/operator/http` exports `RestartRequiredRefusal`, `ReloadPreflightRefusal`, `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, and the derived client decodes a refused reload into one of them.
- 425e240: An accepted reload evaluates new or changed schedule loops at once instead of up to a minute later. `ScheduleTriggers.run` takes the `get` and `changes` of a `CurrentInstance`, like `PollingTriggers.run`.
- ba8e26f: A reload applies `workers` changes without affecting running attempts. A higher `max_concurrent_attempts` preflights the new slots and lets them take waiting runs at once, a lower one retires extra slots as their attempts end, a new worker of the executor's kind takes attempts once preflight passes (the SSH composition re-adds only workers it started with), and a removed worker leaves the scheduler after its last attempt. A changed kind or setting, a renamed worker, or a new worker that the executor can't run still fails the reload with `RestartRequiredError`.
  
  `RestartRequiredError` adds `fields` (such as `workers.build-1.destination`), `ReloadPreflightError` adds `workers` and allows empty `agents`, and `InstanceReload` adds `workers`. `CurrentInstance.registerWorkers`, which takes a `WorkerReload`, replaces `registerPreflight`, and `stepExecutorLayer` takes `StepExecutorOptions` with `startupWorkersOnly`.
- 2fc760a: Renames the item-level hold to suppression, so hold means only the session hold. In `@usine/engine/engine`, the `Held` submission result becomes `Suppressed`, and in `@usine/engine/run-reader`, `LoopSighting.heldBy` becomes `suppressedBy`. In `@usine/orchestrator/operator`, `HeldForOperatorView` becomes `SuppressedForOperatorView`, whose tag is `SuppressedForOperator`. A migration renames the `usine_loop_items` columns `held_by_run_id` and `held_event_id` to `suppressed_by_run_id` and `suppressed_event_id` and keeps their values.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- cba7d35: Operators can run a succeeded or canceled run again. `RunEngine.runAgain` takes a `RunAgainRequest` and records a new event for the run's item state with the dedup key `["operator-run-again", n, <trigger dedup key>]`; it returns `Claimed` or `CycleBlocked`, and fails for a run in another state or while another run of the loop is open on the item.
  
  Adds `canRunAgain` to `RunState.operatorActions`, `RunAgain` to `@usine/core/run/again`, the `usine_run_again_events` table, `runAgain` to `RunSnapshot`, `RunSummary`, and `RunView`, `Operator.runAgain` with the new `LoopNotFoundError`, and `POST /api/runs/:runId/run-again`. The drawer and run page offer **Run again** and **Edit and run again** on succeeded and canceled runs.
- 36788c2: Runs record who approved them, when, and through which channel, `ui` or `github-ask`. Adds `ApprovalSource` and `RunApproval` to `@usine/core/run/approval`, moves `OperatorLogin` from `@usine/config/factory` to `@usine/core/operator`, and `RunEngine.approve` and `RunStore.approve` take an `ApprovalSource`; a migration adds `channel` and `approver` to `usine_approvals`.
  
  `Operator.approve` takes the loaded instance and approves as the `operator` login in `usine.yaml`. `RunView.approval` is an `ApprovalView`, and the run page shows “Approved by <login> · <time> · from the UI” or “from the GitHub Ask”.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- ec5c4d4: Adds `BoardMoves` to `@usine/engine/board-moves`, which records the operator's board moves in the new `usine_board_moves` table. `Operator.moveBoardItem` records each move before it sends the label swap, and `Operator.githubChanges` lists a matching label change as a `BoardMovedView`, so the run page shows it as the operator's move.
  
  Moves made before this change still show as the agent's label changes.
- cef956c: Adds `GitHubItemHistory.appChanges(repository, item, since)` to `@usine/github/item-history`, which returns the App's label changes, comments, and reviews on an item as `LabelAdded`, `LabelRemoved`, `Commented`, and `Reviewed`; `Installation` adds `appSlug`. `Operator.githubChanges(runId)` returns each attempt's changes as `RunGitHubChangesView` at `GET /api/runs/:runId/github-changes`, which returns 404 `GitHubItemNotFoundError` for an item that GitHub no longer has.
  
  The run page shows each label change, comment, and review that an agent made on the item where it happened.
- b99cdc8: While a task's newest open run is `Running` and its item is open, the board keeps its card in the first label lane that matches the item's labels when the trigger matched. A loop that removes its trigger label first, such as `review-pr` removing `ready-for-review`, no longer moves its card to a state lane while it runs.
  
  `projectBoard` takes the running runs' events as an optional last argument, and the error type of `Operator.moveBoardItem` includes `RunStoreError`.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 40194a0: The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.
  
  `AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
- 7b157ff: Runs attempts on SSH workers behind a gateway, with no GitHub token on the worker machine (ADR 0027).
  
  In `@usine/config/factory`, an `ssh` worker takes an optional `gateway` with `domain`, `destination`, `admin_port` (default 7070), `admin_token_env` (the environment variable that contains the admin token, which never goes in the file), and `llm_providers` (`[anthropic]` if the gateway has the Anthropic credential). `@usine/core/worker` adds `GatewayDomain` and `GatewayLlmProvider`, and `@usine/gateway/admin` exports `AttachmentId`, `InstallationCredential`, `CallerToken`, and `GATEWAY_TOKEN_HEADER`.
  
  The SSH executor attaches each attempt's token to the gateway instead of writing it on the machine, clones from `http://git.<domain>/`, and sends the caller token only through SSH `SendEnv`. Preflight checks the admin API, that sshd accepts the `SendEnv` variables, and access to `git.<domain>`, and reports a gap as a `WorkerCapabilityError` with the new `gateway` capability; it refuses a Codex brain, and a Claude brain unless the gateway has the Anthropic credential.
  
  The SSH layer requires an `HttpClient`, `RemoteAccess` adds `shell`, `RemoteWorker.repositoryUrl` takes the machine, and `sshWorkerAddressesOf(config)` fails at startup with the variable's name if an admin token variable is unset.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".
- 34dec09: Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.
  
  The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
- f060b57: Adds `closedAt` to `RunView` in `@usine/orchestrator/operator`, which the desk's last outcomes use, and `usage` to `BoardTaskView`: a `TaskUsageView` with the task's wall time, tokens, and dollars per billing pool (`TaskPoolUsageView`). A pool's `unpriced` flag marks its `cost` as a lower bound, and `RunUsageReader.read` accepts a run summary as well as a snapshot.
  
  Add the new fields to code that constructs `RunView` or `BoardTaskView`.
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- af28e0e: `Operator.detail` caches the token reports of ended attempts in memory until the orchestrator restarts. Each poll from the run page and drawer reads only the running attempt.
- 9464a41: Repository names in `usine.yaml` and loop selectors, and board lane labels, match case-insensitively, as on GitHub. `usine.yaml` rejects repos or selector entries that differ only in case, and lane `label` sources that differ only in case count as one.
- 81c048b: `StepExecutor.execute` takes an `ExecutionSink`: the attempt's channel sink and `checkoutAcquired`, which the executor runs once preparation acquires the checkout. Until then, the engine reconciles a checkout that a restart kept for reattachment: canceling the run records the salvage and removes the checkout, and a failed reattachment reconciles it before the failure is recorded.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- ebfb373: A deleted or transferred issue that the queued-event recheck finds missing leaves the board's open lanes. `TriggerCondition.recheck` replaces `TriggerCondition.holds` and returns a `TriggerRecheck` from `@usine/engine/trigger-condition`: `matches`, `no-longer-matches`, or `item-gone`.
  
  For the last two, the engine revokes the item's queued events, and for `item-gone` it also calls `ItemProjectionWriter.markGone`. An adapter that can't tell returns `matches`, as it returned `true` before.
- 291d428: At most every 10 minutes per repository, the poll marks deleted or transferred issues as gone, removing their cards from the board's open lanes and revoking their unstarted runs.
- 3ed742f: An open pull request that GitHub no longer has leaves the board's open lanes. The poll calls the new `ItemProjectionWriter.markGone`, which sets `goneAt` on the item's projection until a later poll sees the item again, and the board places a gone item by its closed state; a migration adds `gone_at` to `usine_item_projections`.
- 8a0bcc1: An `if:` that fails to evaluate on an item no longer stops the repository's poll: the failure affects only that loop and item, and the cursor advances. **Needs you** lists `if:` and prompt failures with their loop and item while they last, and the first poll after a restart evaluates failing items again.
- af28e0e: `RunReader.closed({ limit })` returns the `limit` most recently closed runs, newest first, regardless of when they opened. The overview's **Last outcomes** uses it, so it lists a run that opened long ago and closed recently.
- 564449d: An open pull request or failing item that GitHub no longer has no longer stops its repository's poll. The poll logs a warning, drops the item from the cursor, and revokes its unstarted runs; `GitHubPolling.snapshot` fails with `GitHubItemNotFoundError`, exported from `@usine/github/polling`, when the item is missing or GraphQL reports `NOT_FOUND`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d0944ca: Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- 72d0fae: A queued event's trigger recheck gives up after five seconds with a warning, and the event proceeds.
- 8c6a3aa: `/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.
  
  `ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.
- 3ed742f: The queued-event recheck no longer opens a run for an item that GitHub no longer has. On `GitHubItemNotFoundError`, `TriggerCondition.holds` returns `false` and the item's queued events are revoked; a failed request or a recheck over five seconds still opens the queued event.
- ca2e7a5: If GitHub refuses to mint an attempt's token, the attempt fails with GitHub's reason, without a retry; outages and rate limits are retried.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- 3f13b80: `StepExecutor.reserve` takes `worker: Option<WorkerName>`. With a worker, the lease comes only from that worker, and the scheduler serves the reservation before unnamed ones without blocking runs that another worker can take.
  
  `StepExecutor` adds `occupy(worker)`, which takes a slot at once for an attempt already running on the worker, even beyond `max_concurrent_attempts`, and logs a warning in that case.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- ff148e0: Retries a failed exe.dev credential grant renewal every minute until it succeeds, and sizes the grant window independently of `max_attempt_minutes`. The run drawer shows the last salvage failure of a retained worktree, which every startup retries; the recorded failure includes git's stderr and names a stalled push instead of a bare `TimeoutError`.
- 7853f53: A reload can add an SSH worker and reads its gateway's admin token before preflight; an unset token variable refuses the reload. A removed SSH worker leaves after its last attempt.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
- d98bef0: Worker preflight checks the machine's memory against `max_concurrent_attempts`, and `Executor.preflight` takes `maxConcurrentAttempts` as a third argument. Preflight fails with the new `memory` capability below 1.5 GiB per concurrent attempt, or with no swap and more than one concurrent attempt, and warns below 3 GiB per concurrent attempt.
- Updated dependencies [a3a230c]
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [efdcf43]
- Updated dependencies [b36ffc7]
- Updated dependencies [6672585]
- Updated dependencies [9464a41]
- Updated dependencies [9739f3a]
- Updated dependencies [425e240]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [ca2e7a5]
- Updated dependencies [7a6d96f]
- Updated dependencies [b928d0d]
- Updated dependencies [499dd2c]
- Updated dependencies [e518906]
- Updated dependencies [759db71]
- Updated dependencies [8292038]
- Updated dependencies [0799f4f]
- Updated dependencies [14c2d3c]
- Updated dependencies [d3942c0]
- Updated dependencies [d039c91]
- Updated dependencies [0799f4f]
- Updated dependencies [81c048b]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [7db1cae]
- Updated dependencies [425e240]
- Updated dependencies [66f6b0b]
- Updated dependencies [eedf20c]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [3ed742f]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [81c048b]
- Updated dependencies [af28e0e]
- Updated dependencies [23e8f15]
- Updated dependencies [91e2b70]
- Updated dependencies [291d428]
- Updated dependencies [564449d]
- Updated dependencies [32cf39b]
- Updated dependencies [291d428]
- Updated dependencies [75a4fcf]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [4d4c6bd]
- Updated dependencies [5870baf]
- Updated dependencies [562ba5f]
- Updated dependencies [0dac1bd]
- Updated dependencies [8c6a3aa]
- Updated dependencies [99164fa]
- Updated dependencies [3f13b80]
- Updated dependencies [b601259]
- Updated dependencies [3088f0e]
- Updated dependencies [6d70b40]
- Updated dependencies [2729e91]
- Updated dependencies [81c048b]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [7a5249f]
- Updated dependencies [2fc760a]
- Updated dependencies [d799713]
- Updated dependencies [3f13b80]
- Updated dependencies [42720dd]
- Updated dependencies [c604a43]
- Updated dependencies [f966404]
- Updated dependencies [42780b5]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [e5d9483]
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [f060b57]
- Updated dependencies [8f43ed7]
- Updated dependencies [6764fa7]
- Updated dependencies [ec5c4d4]
- Updated dependencies [b99cdc8]
- Updated dependencies [cef956c]
- Updated dependencies [466e711]
- Updated dependencies [1877119]
- Updated dependencies [ff148e0]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [7853f53]
- Updated dependencies [ba8e26f]
- Updated dependencies [761099a]
- Updated dependencies [dda5892]
- Updated dependencies [6714868]
- Updated dependencies [d933ab6]
- Updated dependencies [32651fd]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
- Updated dependencies [d3942c0]
- Updated dependencies [fcd3671]
- Updated dependencies [425e240]
- Updated dependencies [d98bef0]
- Updated dependencies [8665053]
  - @usine/config@0.3.0
  - @usine/core@0.4.0
  - @usine/durable@0.1.0
  - @usine/executor@0.3.0
  - @usine/engine@0.4.0
  - @usine/expression@0.3.0
  - @usine/github@0.2.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- 8b9d544: Adds operator takeover, session pause and resume, and edit-and-retry (protocol v5). A message to a child holds its result until release, holds pause the elapsed-time limit, and v3 and v4 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/executor@0.2.1
  - @usine/run-host@0.3.0
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 3f80f88: Applies `settings.max_children` as a child-session budget per attempt; an excess spawn fails without a retry (protocol v4). v3 transcripts stay readable.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 333eacd: Adds `settings.parent_effort` in `usine.yaml` and `parent_effort` in agent files for the Pi parent's reasoning effort, which defaults to the child's. A parent model that can't run it fails with `UnsupportedEffortError`.
- 57a374f: Preflight checks harness executables and logins on local and exe.dev workers, and Codex requires codex-cli 0.144.0 with ChatGPT authentication. Capability gaps need operator action; incomplete checks are retried.

### Patch Changes

- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- b9e38a7: Moves expression schemas, environment descriptors, and typed errors from `/model` to `@usine/expression/expression-engine`; update your imports. GitHub contracts are reorganized without changing public entry points.
- 485f244: Starts PR-triggered attempts at the event's exact head commit.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- e7adbd8: Derives operator actions from the run lifecycle rules.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [3db806c]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [410607d]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [333eacd]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [7dc019e]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/executor@0.2.0
  - @usine/run-host@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- da13037: Runs attempts through an in-process Pi parent with the usine subagents extension and a headless Claude Code child, and streams typed session events over protocol v2.
- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 27004c2: Adds the exe.dev worker adapter, with time-boxed GitHub integration grants, cached remote worktrees, capability preflight, and idempotent cleanup.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.
- 6e61cbf: Adds the local worker runtime: scheduling, isolated Git worktrees, per-attempt credentials, durable transcripts, structured results, and cancellation.
- 1a9669d: Polls GitHub with conditional REST requests, stores trigger cursors in the run database, and turns matching loop state into durable events.
- 05937b8: Adds schedule triggers with IANA time zones, one tick per repository, and catch-up of the latest missed tick.

### Patch Changes

- Updated dependencies [da13037]
- Updated dependencies [16e7212]
- Updated dependencies [a8d8df4]
- Updated dependencies [95b26af]
- Updated dependencies [27004c2]
- Updated dependencies [24eef02]
- Updated dependencies [57d383b]
- Updated dependencies [fb24c80]
- Updated dependencies [ae86c6c]
- Updated dependencies [6e61cbf]
- Updated dependencies [1a9669d]
- Updated dependencies [bc17c21]
- Updated dependencies [7bd5cdb]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/engine@0.1.0
  - @usine/executor@0.1.0
  - @usine/run-host@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0

## 0.0.1

### Patch Changes

- 781b664: First publish of the nine usine blocks. `@usine/core` contains the event, run, step, and attempt domain model, the run state machine, and the attempt failure kinds.
