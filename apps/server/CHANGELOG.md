# @usine/server

## 0.3.0

### Minor Changes

- 794a1cf: `usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, to `<name>.durable<ext>` next to the runtime database copy. Restore both files together; an attempt that was running at backup time then reattaches to its parent task.
  
  `@usine/durable/backup` exports `backup` and `DurableStorageBackupError`, and `@usine/durable/live` no longer exports `durableStoragePath`.
- 56ce81e: Adds `GET /api/configuration`, which returns the parsed instance folder with its runtime state: loops, agents, workers, gateway settings (the admin token's variable name only), repositories, settings, and quarantined loops and invalid agents with their errors. It also responds in setup mode.
  
  `@usine/orchestrator/operator` exports `OperatorConfiguration` and `ConfigurationView`, and `stepExecutorLayer` provides `WorkerStatus` from `@usine/orchestrator/worker-status`. The web UI adds a Configuration section with read-only pages for loops, agents, workers, repositories, and settings, each with a **Reload configuration** button.
- 42720dd: Operators can mark a failed run's latest failure resolved, clearing its attention flags but keeping its outcome, transcript, and retry controls. Later failures flag it again; stale requests are rejected.
- 466e711: When an attempt ends without success, the executor commits uncommitted changes, pushes HEAD to `usine/salvage/<run>/<attempt>`, shows the ref in the run drawer, and checks it out for the next retry.
  
  `max_attempt_minutes` and `max_attempt_tokens` have no default: an absent setting leaves that half of the runaway guard off, and an armed limit steers the parent once at 80% before tripping. Consumed tokens count output plus uncached input for Codex, Claude, and Pi. The attempt channel protocol is version 7, and stored protocol-v6 transcripts stay readable.
  
  Startup reconciles retained and crashed attempts before workflow recovery, work is retained if salvage inspection or a snapshot fails, and local credentials and exe.dev grants renew throughout an attempt.
- 7882203: Adds an `ssh` worker kind for any Linux machine that the orchestrator connects to over SSH (ADR 0026). In `usine.yaml`, an `ssh` worker takes `destination` (`user@host` or an SSH configuration alias), optional `identity_file` and `port`, and `root`, the directory for `workers/<name>` on the machine.
  
  `WORKER_KINDS` in `@usine/core/worker` adds `"ssh"` with the `SshDestination`, `SshPort`, `SshIdentityFile`, and `WorkerRoot` schemas, `Worker` in `@usine/config/factory` is a union of `LocalWorker`, `ExeDevWorker`, and `SshWorker`, and `@usine/executor/ssh` is a new adapter. Each attempt's token is written next to the worker's checkouts with mode 600 and removed when the attempt ends; all attempts on a worker run as one SSH user and can read each other's tokens (#231).
  
  `@usine/orchestrator/ssh` composes the engine with the SSH executor and exports `sshWorkersOf(config)`. `runtimeLayer` and `operatorObservationLayer` move from `@usine/orchestrator/local` to `@usine/orchestrator/runtime`, and `runtimeLayer(instanceDirectory, instance)` no longer takes local executor options and selects the SSH executor when every worker is `ssh`. The exe.dev adapter's span and log names change to `RemoteExecutor.*` and "remote".

### Patch Changes

- d866d8f: Adds `item` to `ApprovalNeed` in `@usine/orchestrator/operator`: the item that the waiting run would work on, or null if no board card shows it.
  
  Restyles the web UI with Catppuccin Mocha, Inter, and JetBrains Mono. **Needs you** shows each approval with its loop and task, and the board lists label lanes first, collapses Unmapped and closed-item lanes, keeps lane headings visible while scrolling, and labels the arrow between two lanes with the loops working in the left one.
- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 4970fc4: The board card menu offers **Run again** when the task's latest run succeeded or was canceled. The event of the new run links to the run it ran again.
- 0275eff: Adds attempt end times: `Attempt.endedAt` in `@usine/core`, an `ended_at` column in `usine_attempts`, and `AttemptView.endedAt` in `@usine/orchestrator/operator`. Attempts that ended before this change have no end time.
  
  The board shows each lane's labels, in their GitHub colors, and item states under its name. A card shows a run only while the run is open or failed and unresolved, with the time since the run opened, its current attempt started, or it failed, and the card menu lists only the actions that apply.
- a386108: Adds `BoardTaskView.loops`: the loops, paused ones included, whose trigger matches one of the task's items. `OperatorObservation.layer` provides `LoopMatches` to the overview.
  
  On the board, a card whose item is on the overview's **Not moving** list shows the reason and the action that moves it again. The arrow between two lanes lists the loops whose trigger matches a task in the left lane and marks paused ones.
- 39a0fae: `usine up` checks its HTTP port before it opens any store or resumes any attempt. If the port is in use, it exits and shows the listening process's id when `lsof` finds it.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- af28e0e: Adds an optional `at` to `Comment` in `@usine/core/step/result`: the time GitHub says the comment was posted. `TaskCommentView` in `@usine/orchestrator/operator` replaces `at` with `postedAt` and `attemptEndedAt`, and the task page dates comments and reviews by when they were posted.
- af28e0e: An attempt that fails or is canceled records the comments and reviews it posted on its run's item, and the task page lists them for every ended attempt.
  
  Adds `Attempt.comments` and `AttemptChannel.Sink.comments` to `@usine/core`, `harvestPostedComments` to `@usine/core/step/harvest`, and `RunStore.recordComments` with a `comments_json` column in `usine_attempts` to `@usine/engine`. `TaskView.comments` in `@usine/orchestrator` includes these comments, newest first.
- 40097d3: **Needs attention** reflects a run action sent from any page: while an approval or cancel is in progress, the entry's buttons are disabled and show the action, such as "Approving…", and the entry disappears when the action succeeds. An approval refused because the run already moved on shows no error on the entry.
- de1b041: `usine up` locks the instance folder with `.usine/instance.lock` until every store closes. A second `usine up` in the same folder exits with a nonzero status before it opens any store and shows the running process from `.usine/instance.pid`.
- 75a4fcf: The web UI opens on the desk instead of the Projects list. The desk shows **Needs you**, **Running now** (attempts in flight, with connectivity warnings), **Not moving** (matched items with no running attempt, each with the reason and the action that moves it again), **Last outcomes** (the 10 most recently closed runs), and each worker's slots and last preflight; the sidebar lists projects under a Desk entry.
  
  Adds `RunReader.sightings` (`LoopSighting`), `OperatorObservation.desk` (`DeskView`), the `LoopMatches` service, `PollCycle.repositoryPolls`, and `GET /api/desk`, which also responds in setup mode. A not-moving item has one reason: `AwaitingApproval`, `SuppressedForOperator`, `CycleBudgetUsedUp`, `RunFailed`, `ClosedUnchanged`, `LoopPaused`, `QueuedForWorker`, or `AwaitingPoll`. `OperatorObservation.layer` requires `ExpressionEngine` and `WorkerStatus`, and `WorkerStatus.idle` serves a process that runs no attempts.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- d0944ca: Expected failures of a `usine` command print one plain message instead of an Effect cause: an invalid `usine.yaml` shows the file, stage, and key, and a failed worker preflight shows the worker, check, and cause. Defects still crash with their full trace.
- 046d10b: Rewrites the web UI copy in short plain words. The home page is **Overview**, with **Needs attention**, **Running**, **Stalled**, and **Recent runs**; stall reasons are short fragments such as `Waiting for a free worker slot`; glossary nouns are lowercase in sentences; and menus say **Open run** and **Cancel run**.
- 0dac1bd: `usine up` logs a warning with the file, stage, and message for each loop or agent file it left out, and **Needs you** lists each one as a `ConfigFileNeed` (`@usine/orchestrator/operator`).
- 8c6a3aa: `/api/overview` and `/api/desk` respond in under 200 ms when polled together on a board of 500 items and five loops, down from over 700 ms each. `MarcbachmannCelLayer` builds each cel-js environment once and caches each expression's check result and parsed form.
  
  `ExpressionEngine` adds `evaluateBooleanEach`, which checks a condition once and evaluates it on many contexts, with failures kept per context; implementations of `ExpressionEngineService` must provide it. `LoopMatches` uses it.
- 1d94c11: The run page's reader keeps following a live run when you press End, Space, ArrowDown, or PageDown, or scroll down at the latest message.
- 4f6611b: The run page's reader keeps following a live run when you scroll a long tool output at the latest message.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 39f8d4b: `usine up` reloads the instance folder on `SIGHUP`, `POST /api/instance/reload`, or **Reload configuration** on the Loops page, including in setup mode, and `SIGHUP` no longer ends the process. A refused reload returns 422 `FactoryConfigError` for an invalid `usine.yaml` or 409 `RestartRequiredError` for a changed `workers` or `webhooks` block.
- 419bbd7: A reload whose new or changed agent's brain fails worker preflight returns 409 `ReloadPreflightError` and keeps the running configuration. After an accepted reload, polling starts at once.
- af28e0e: A refused `POST /api/instance/reload` returns the refusal's typed fields with `error` and `message`: `blocks` and `fields` for `RestartRequiredError` (409), `agents`, `workers`, and `cause` for `ReloadPreflightError` (409), and `file` and `stage` for `FactoryConfigError` (422). The Configuration section lists what the refusal names, each linked to its page.
  
  `@usine/orchestrator/operator/http` exports `RestartRequiredRefusal`, `ReloadPreflightRefusal`, `FactoryConfigRefusal` (`ReloadRefusal`), `ReloadPreflightFailure`, and `reloadRefusal`, and the derived client decodes a refused reload into one of them.
- ba8e26f: A reload resizes, adds, and removes workers, and its response lists the changed workers. A `workers` change that needs a restart returns 409 `RestartRequiredError`, and a new worker or slot that fails preflight returns 409 `ReloadPreflightError`.
- 7a5249f: While a worker that a reload removed still runs attempts, its **Worker not configured** entry in **Needs attention** shows how many and offers **Discard leftovers** only after they end. Adds `UnconfiguredWorkerNeed.running` and `RunReader.attemptsByWorker` (`WorkerAttempts.running`).
  
  `RunEngine.discardLeftovers` and `Operator.discardLeftovers` fail with `LeftoversDiscardRejectedError` for a worker that is declared or still runs attempts, and `POST /api/workers/:worker/discard-leftovers` returns 409 with it instead of `{ ok: true }`.
- f966404: An operator retry of a failed run, plain or edited, fails with `RunRetryBlockedError` (status 409 in the API) while another run of the same loop and item is open.
- e5d9483: Rewords the `--allow-volatile-instance` help and the TSDoc for `VolatileInstanceDirectoryError` and `volatileRoot`.
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
- 40194a0: The run page's **Resume this session** block gives a command that you can run from your own terminal, also for an attempt on an SSH worker: `cd -- '<cwd>' && claude --resume '<id>'` (or `codex resume --`), wrapped in `ssh -t <destination>`, with `-p <port>` if set, for an SSH worker. **Copy command** copies it as one line.
  
  `AttemptView` in `@usine/orchestrator/operator` adds `workerAccess` (`WorkerAccess`): `LocalWorkerAccess`, `SshWorkerAccess` with `destination` and `port`, or null if `usine.yaml` no longer declares the worker; an exe.dev worker reads as `SshWorkerAccess` to `<name>.exe.xyz`. `OperatorObservation.detail` and `Operator.detail` take the loaded instance as their first argument.
- 34dec09: Adds `OperatorObservation.task(instance, repository, item)` to `@usine/orchestrator/operator`, which returns the `TaskView` of the task that contains the item: its items, lane, runs, and recorded comments and reviews. It covers the project's 500 newest items, fails with `BoardItemNotFoundError` or `BoardProjectNotFoundError`, and is served at `GET /api/projects/:owner/:repository/tasks/:item`, also in setup mode.
  
  The web UI adds the task page at `/projects/<owner>/<name>/tasks/<number>`, with the task's items, runs, pull requests, and comments and reviews. Clicking a board card opens it.
- 1480ced: The tasks list appends the last run's time to the status, such as `Done · 28m ago`, and removes the Last run column. Elapsed time and cost show the figure alone, with a muted `*` and a tooltip when the real figure is higher, and the figure columns take only the width they need.
- af49fc2: The tasks list counts a stalled task as in flight only while an open run, a question or blocker, a used-up cycle budget, or an unresolved failure stalls one of its loops. Other stalled tasks sort with finished tasks by when their last run closed and keep the stall reason as their status, and the heading counts a task as needing attention only while a failed run or a suppression waits on the operator.
- f060b57: The tasks list shows only tasks with at least one run, finished ones included, and removes the Done toggle and `?done=1`. Each row shows the status, the loops that ran, the run count, the last run, the pull request, and the task's time, tokens, and cost; tasks in flight come first by when their run opened, then the rest by when their last run closed.
- 1a61d7e: The tasks list keeps each task title on one line in the width the other columns leave, with at least 416px for the title. Past that, Status and Last run wrap and Runs truncates.
- dda5892: `@usine/config/board` exports `isSettledItemState`, true for `issue-closed`, `pr-closed`, and `pr-merged`, which the board projection and the web UI's Done lanes use. `BoardTaskView` adds `updatedAt` and `pullRequest` (`BoardPullRequestView`); add both to code that constructs a `BoardTaskView`.
  
  The web UI adds a tasks list per project at `/projects/<owner>/<name>/tasks`, with each task's current item, state, lane, loops, run count, last run, and pull request, and a **Done** toggle (`?done=1`) for closed and merged tasks. The sidebar shows **Board** and **Tasks** under each project.
- d933ab6: Each package writes its `tsc -b` build info under `dist/`, so removing `dist` also removes the incremental state. The build info isn't published.
- 32651fd: Startup skips reconciling attempts recorded on a worker that `usine.yaml` no longer declares, logs one warning per start, and lists each such worker in **Needs you** as an `UnconfiguredWorkerNeed` with its attempt count. Declaring the worker again reconciles them at the next start, and **Discard leftovers** (`POST /api/workers/:worker/discard-leftovers`, `RunEngine.discardLeftovers`) stops tracking them without changing the worker.
  
  Adds `StepExecutor.workers`, `RunReader.attemptsByWorker`, and a `leftovers_discarded_at` column in `usine_attempts`.
- Updated dependencies [a3a230c]
- Updated dependencies [d866d8f]
- Updated dependencies [0fc7e8f]
- Updated dependencies [794a1cf]
- Updated dependencies [3ed742f]
- Updated dependencies [f060b57]
- Updated dependencies [0275eff]
- Updated dependencies [a386108]
- Updated dependencies [efdcf43]
- Updated dependencies [af28e0e]
- Updated dependencies [6672585]
- Updated dependencies [9464a41]
- Updated dependencies [9739f3a]
- Updated dependencies [425e240]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [56ce81e]
- Updated dependencies [7a6d96f]
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
- Updated dependencies [66f6b0b]
- Updated dependencies [eedf20c]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [291d428]
- Updated dependencies [3ed742f]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [8a0bcc1]
- Updated dependencies [81c048b]
- Updated dependencies [af28e0e]
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
- Updated dependencies [d0944ca]
- Updated dependencies [562ba5f]
- Updated dependencies [0dac1bd]
- Updated dependencies [72d0fae]
- Updated dependencies [8c6a3aa]
- Updated dependencies [99164fa]
- Updated dependencies [3f13b80]
- Updated dependencies [b601259]
- Updated dependencies [3ed742f]
- Updated dependencies [3088f0e]
- Updated dependencies [6d70b40]
- Updated dependencies [2729e91]
- Updated dependencies [ca2e7a5]
- Updated dependencies [ebfb373]
- Updated dependencies [a999ca0]
- Updated dependencies [39f8d4b]
- Updated dependencies [419bbd7]
- Updated dependencies [af28e0e]
- Updated dependencies [425e240]
- Updated dependencies [ba8e26f]
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
- Updated dependencies [cba7d35]
- Updated dependencies [36788c2]
- Updated dependencies [f060b57]
- Updated dependencies [8f43ed7]
- Updated dependencies [6764fa7]
- Updated dependencies [ec5c4d4]
- Updated dependencies [b99cdc8]
- Updated dependencies [cef956c]
- Updated dependencies [b99cdc8]
- Updated dependencies [466e711]
- Updated dependencies [1877119]
- Updated dependencies [ff148e0]
- Updated dependencies [40194a0]
- Updated dependencies [7853f53]
- Updated dependencies [7b157ff]
- Updated dependencies [7882203]
- Updated dependencies [ba8e26f]
- Updated dependencies [761099a]
- Updated dependencies [34dec09]
- Updated dependencies [f060b57]
- Updated dependencies [dda5892]
- Updated dependencies [d933ab6]
- Updated dependencies [32651fd]
- Updated dependencies [a3a230c]
- Updated dependencies [10ab5af]
- Updated dependencies [d98bef0]
- Updated dependencies [8665053]
  - @usine/config@0.3.0
  - @usine/orchestrator@0.3.0
  - @usine/core@0.4.0
  - @usine/durable@0.1.0
  - @usine/engine@0.4.0
  - @usine/expression@0.3.0
  - @usine/github@0.2.0

## 0.2.1

### Patch Changes

- 5828a95: Persists Claude and Codex child sessions, and the run drawer shows copyable resume commands. Protocol v6 needs the orchestrator and run host upgraded together; v3 to v5 transcripts stay readable.
- Updated dependencies [5828a95]
- Updated dependencies [8b9d544]
  - @usine/core@0.3.0
  - @usine/engine@0.3.0
  - @usine/orchestrator@0.2.1
  - @usine/config@0.2.1
  - @usine/github@0.1.2

## 0.2.0

### Minor Changes

- 8b6718d: Reworks the run conversation with expandable tool activity, live session status, transcript filters, and scrolling that keeps your position, and moves task, event, and attempt details to separate tabs.
- 388e59d: Adds `usine export-run <runId>`, which saves a run's detail, attempts, and transcripts to a new JSON file (set the path with `--output <path>`). Adds `RunReader.evidence(runId)` and the read-only `runReaderLayer(instanceDirectory)`.
- 83edd04: Adds `usine backup <path>`, which copies the runtime database, including committed WAL data, while the orchestrator runs, and never overwrites an existing file.
- aeb587f: Groups adjacent completed tools into expandable summaries and shows the active command or file with its elapsed time. File edits show their patch first.
- ef9fd20: Shows new conversation updates while you read earlier activity, and adds jumps to the latest message and to errors.

### Patch Changes

- ffc26c9: Completed tool groups show compact action summaries with file names and recognized test or build commands.
- 162b323: Records executor defects as non-retryable attempt failures with safe operator messages, and matches task relationships by canonical PR paths.
- c7c8a79: Expanded run tools use flat disclosure rows; code, terminal output, and diffs keep separate panels with copy controls.
- 5c47dc2: On SIGINT or SIGTERM, the orchestrator drains admitted attempts and defers queued work and retries until restart; a second signal forces a stop.
- f4f5938: Failed commands stay in their activity group, which shows an error count, and error navigation opens collapsed groups to show the failure.
- a36f46e: Adds `max_cycles` (default 3 per loop), a per-item cycle budget with an ask when it's used up and a reset in the UI and API. Agents that share a GitHub App identity review with comments and outcome labels.
- f42d393: Publishes the operator HTTP contract at `@usine/orchestrator/operator/http`; URLs, responses, and operator actions don't change.
- 354e598: Creates declared GitHub labels before polling and warns when board lanes or loop triggers use undeclared labels. Label names allow at most 50 characters and no surrounding whitespace.
- 7cf4887: Board moves refresh from GitHub and evaluate their loops at once instead of at the next poll, and moved cards stay in their destination through stale refreshes.
- 28ec315: Supports Codex CLI 0.153.4 and stops Codex child processes, including leftover background commands, before their sessions complete.
- 6b53a10: Simplifies run tool activity with indented groups and fewer separators, and file reads show a line range instead of offset and limit fields.
- dd81b60: Proposed board lanes are read-only. To enable moves, configure a lane map in `usine.yaml`; moves exchange only its labels.
- 2cfd65b: Serves the web app for direct requests to client-side routes, and still returns 404 for unknown API routes and missing static files.
- b628897: Groups linked issue and PR items into board tasks with their run history and run and attempt counts.
- 580a873: Each run conversation remembers its filter, open disclosures, and reading position across drawer closes and page refreshes.
- Updated dependencies [3f80f88]
- Updated dependencies [162b323]
- Updated dependencies [388e59d]
- Updated dependencies [5c47dc2]
- Updated dependencies [a36f46e]
- Updated dependencies [b9e38a7]
- Updated dependencies [83edd04]
- Updated dependencies [f42d393]
- Updated dependencies [333eacd]
- Updated dependencies [485f244]
- Updated dependencies [354e598]
- Updated dependencies [bd45cf4]
- Updated dependencies [7cf4887]
- Updated dependencies [dd81b60]
- Updated dependencies [e7adbd8]
- Updated dependencies [b628897]
- Updated dependencies [4c97cae]
- Updated dependencies [57a374f]
  - @usine/config@0.2.0
  - @usine/core@0.2.0
  - @usine/engine@0.2.0
  - @usine/orchestrator@0.2.0
  - @usine/expression@0.2.0
  - @usine/github@0.1.1

## 0.1.0

### Minor Changes

- 16e7212: Adds per-repository board lane maps, item and label projections from polling, live run data on board cards, quarantined item diagnostics, and lane label moves through the operator API.
- 24eef02: Adds CLI port overrides, help and version output, and occupied-port diagnostics to `usine up`. The operator API hides infrastructure causes and limits transcript reads, and the drawer loads more than 500 rows.
- ae86c6c: Adds `usine up` with a local UI that lists open and recent runs with their transcripts and offers approve, retry, cancel, pause, and unpause. Loop pause state persists in the runtime database.

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
- Updated dependencies [05937b8]
- Updated dependencies [3041f9d]
  - @usine/config@0.1.0
  - @usine/core@0.1.0
  - @usine/orchestrator@0.1.0
  - @usine/github@0.1.0
  - @usine/expression@0.1.0
