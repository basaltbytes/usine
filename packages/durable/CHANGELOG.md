# @usine/durable

## 0.2.1

### Patch Changes

- 3fa96e0: Persist outbound envelopes before delivery so a restart preserves child events and intervention results with their original sequences and timestamps. Replay pending batches before new output, and keep terminal envelopes recoverable until delivery completes.
- 93bbe77: Upgrade the Pi packages to 1.4.0 and define the checkpoint policies required by pi-durable. Attempt and hold documents retain their existing delta-storage behavior. Disable the task restart limit to preserve automatic resumption after repeated crashes.
  
  Back up the instance with `usine backup <path>` before upgrading. Starting the upgraded server migrates `durable.sqlite` to SQLite storage schema version 2, which pi-durable 1.3.0 and earlier cannot open. Do not downgrade usine past this release: `usine upgrade <older version>` cannot reverse the storage migration.
- 9af38cb: Install Pi's HTTP dispatcher before opening the first parent harness. Server requests use proxy-aware HTTP/1.1 connections with five-minute stream timeouts, and interrupted response streams reject without an unhandled dispatcher error terminating the process.
- 0f4d653: Report an HTTP 403 on the executor's salvage push as a `GitHubPushFailure` with the repository, refused ref, GitHub's stderr message, and the single-repository installation token scope. The run page and Needs attention show the failure while the checkout remains available for salvage recovery. The failure does not retry the attempt automatically, and a later successful salvage preserves its failure history.
  
  `SalvageRetained.pushFailure` records the typed failure. Older salvage records decode this field as `None`. Canceled attempts remain canceled, and questions and blockers retain item suppression.
- 56e79a7: Settle attempts after confirmed cancellation so a task that completes or fails while its relay fails doesn't trigger repeated cancellation on restart. Preserve terminal delivery state and skip settlement during worker drains.
- 460d50b: Retry temporary model provider capacity refusals automatically, with a delay and the existing three-attempt cap. Retries resume from salvaged work; the run page shows the provider message and the next attempt time. The retry deadline survives orchestrator restarts and cancellation stops the wait.
  
  Add typed capacity failures, child reports, and provider retry starts. Codex and Claude use structured overload codes where available, while message-only errors recognize capacity refusals, HTTP 529, and HTTP 503 with a retry hint. Other task failures retain their existing behavior.
- Updated dependencies [d1fd769]
- Updated dependencies [a7692ae]
- Updated dependencies [6541e90]
- Updated dependencies [6d7f66f]
- Updated dependencies [93bbe77]
- Updated dependencies [7bf348a]
- Updated dependencies [a22dc8e]
- Updated dependencies [06a10bf]
- Updated dependencies [56d4c04]
- Updated dependencies [f54b3bd]
- Updated dependencies [0f4d653]
- Updated dependencies [52c76fa]
- Updated dependencies [98eb9cd]
- Updated dependencies [460d50b]
- Updated dependencies [4f37e20]
  - @usine/core@0.6.0
  - @usine/agents@0.6.0

## 0.2.0

### Minor Changes

- 9c7ea97: Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)).
- 266986a: The nine `@earendil-works/*` packages are at 1.2.0. pi-durable 1.2 closes the harness on any storage error, a read included, so `DurableHarness` now handles a failed harness instead of a poisoned session or a stuck step:
  
  - An attempt that is running when a storage error fails the harness fails with a retryable `InfraFailure` whose cause is the new `DurableStorageFailed`, and the engine retries it from salvage. The harness reopens the storage, aborts those attempts' tasks, and resumes the other tasks.
  - A storage error before the harness resumes its tasks fails the layer with a `DurableHarnessError` that names the error, and `usine up` doesn't start.
  - If the reopen fails, or the reopened harness fails within a minute, the harness stops until the orchestrator restarts.
  
  `HarnessListener` replaces `onReopen` and `onStop` with `onFailure`, `BeforeResume` also receives the storage, and `StuckStepReports` is removed. The `subagent` tool returns the child's report as `output`, the field that pi-durable 1.2 reads instead of `content`.

### Patch Changes

- 1f7b315: Change the license from MIT to AGPL-3.0-only. Versions published before this one stay under MIT.
- 1514af9: On a provisioned worker, the Claude login lock covers one machine instead of the whole worker ([#591](https://github.com/basaltbytes/usine/issues/591)). Each machine has its own login, so a Claude child or preflight check on one machine no longer waits for a Claude start on another. A worker's long-lived machine keeps one lock for all its attempts.
  
  `ClaudeLoginLock.withLock(worker, machine)` takes the provider's `MachineId` of a provisioned machine, or `None` for the worker's shared login. `ChildRequest` and `AttemptRequest` require `machine`, which the executor sets from the attempt's machine. `AttemptRequest.machine` isn't stored; each `execute` call supplies it.
- 9077f43: Fixes a forced stop that never exited after it released a running attempt ([#573](https://github.com/basaltbytes/usine/issues/573)). The attempt's Pi parent kept running until the durable harness closed. If it called `subagent` in that time, the call waited for an `execute` call to supply the child host, and no `execute` call follows in a stopping process. The harness close waits for every running call, so it never finished. An aborted `subagent` call now stops waiting and logs `Abandoning the child spawn of an aborted tool call`. The next start resumes the attempt, and the call ends as interrupted.
- afbac5c: A salvage git command that doesn't finish within the 10-minute command timeout no longer crashes the release of a failed attempt's checkout. Before, the salvage read the message of the timeout's cause, which has none, and threw "Cannot read properties of undefined (reading 'trim')". The run then failed with "Step executor defect; operator intervention required" instead of the attempt's own failure, and the checkout and its provisioned machine stayed on the worker without a recorded salvage (#602). Now the run fails with the attempt's own failure, and the salvage records `Retained` with the worktree's path, so the checkout stays on the worker as it does after any other failed git command.
  
  A worker command that exceeds the timeout now fails with the message `<command> didn't finish within 10 minutes`, instead of `Can't run <command>`, which also named a command that couldn't start.
  
  `@usine/durable/testing` adds `StubChild.crash`, which ends a stub child without a result, as a Claude child whose output stream fails, so the parent's `subagent` call fails with a `stream` `SessionOperationError`.
- Updated dependencies [1f7b315]
- Updated dependencies [8ea9f5b]
- Updated dependencies [d819599]
- Updated dependencies [2f78d3a]
- Updated dependencies [1514af9]
- Updated dependencies [b3e696a]
- Updated dependencies [4942c44]
- Updated dependencies [113d150]
- Updated dependencies [80f2eb6]
- Updated dependencies [3d54b01]
- Updated dependencies [9be864d]
- Updated dependencies [b2df567]
- Updated dependencies [9c7ea97]
- Updated dependencies [9c7ea97]
- Updated dependencies [d82c6cd]
- Updated dependencies [266986a]
- Updated dependencies [4c63872]
- Updated dependencies [6388474]
- Updated dependencies [fdbad56]
- Updated dependencies [fdbad56]
- Updated dependencies [2183c07]
- Updated dependencies [9782e74]
- Updated dependencies [e5d9dcb]
  - @usine/agents@0.5.0
  - @usine/core@0.5.0

## 0.1.0

### Minor Changes

- 0fc7e8f: An attempt reports when its worker stops responding or a child can't reach its model provider. These reports don't stop or fail the attempt.
  
  Adds the payloads `WorkerUnresponsive`, `WorkerResponsive`, and their union `WorkerNotice` to `@usine/core/attempt/channel`, and the session events `ProviderRetrying` and `ProviderRecovered`, with the `ProviderRetries` count, to `@usine/core/agent/session`. Adds `notify` to `AttemptRuntime` in `@usine/durable/attempt-runtime`, which records a `WorkerNotice` in the transcript, and adds both worker payloads to `TranscriptPayload` in `@usine/orchestrator/operator`.
  
  On SSH and exe.dev workers, the executor probes the worker over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second limit. The run page shows the reports as yellow lines, and the current activity says what isn't responding and since when.
- 794a1cf: `usine backup <path>` also copies the durable storage, `.usine/durable.sqlite`, to `<name>.durable<ext>` next to the runtime database copy. Restore both files together; an attempt that was running at backup time then reattaches to its parent task.
  
  `@usine/durable/backup` exports `backup` and `DurableStorageBackupError`, and `@usine/durable/live` no longer exports `durableStoragePath`.
- 425e240: A message to a working child shows as queued until the child reads it, as for a delegating parent. The run page and drawer show it as "Queued until the child finishes its current step".
  
  `RunningSession.intervene` in `@usine/agents/runtime` takes an `OnDelivery` callback and returns `InterventionState.queued` for a message that the harness reads at its next boundary. A child emits `SessionResumed` only if it was idle or paused. The durable attempt runtime records queued input in `AttemptRecordDoc.queuedInputs` and sends a second receipt, `InterventionApplied` or `InterventionRejected`, and the `@usine/durable/testing` stub child queues messages and adds `readQueued`.
- d062b4d: Fixes Claude children failing when two attempts start on one worker and share its Claude login. A Claude child whose first turn fails with `Failed to refresh OAuth token: another Claude Code process ...` without spending tokens restarts after 15, 30, then 60 seconds.
  
  Adds `ClaudeLoginLock` and `ChildRequest.worker` to `@usine/agents/runtime`, and exports `claudeLoginLockLayer` from `@usine/executor`. `claudeChildLayer`, `claudeChildBackendLayer`, the local, exe.dev, and SSH executor layers, the `@usine/durable/live` `layer`, and the `@usine/orchestrator` worker compositions require `ClaudeLoginLock`. Provide one `claudeLoginLockLayer` to both the executor and the attempt runtime.
- 8292038: Adds `AttemptRuntime`, which runs an attempt's Pi parent in the orchestrator as a durable task on pi-durable storage, relays its activity as attempt channel envelopes, applies operator input, and cancels bottom-up. `/live` provides the Node runtime with Claude, Codex, and Pi child backends, and `/testing` runs whole attempts with a scripted parent model and stub children.
- 0799f4f: `AttemptRequest` contains the attempt's child host, which the `subagent` tool passes to every child, so the worker decides where children run. `@usine/durable/testing` adds `stubAttemptRuntime`, `StubStorage`, `StubParent`, `completes`, and `worksFor`, an in-memory `AttemptRuntime` for executor and engine tests.
- 7db1cae: Fixes an orchestrator restart running the agent again when the attempt's parent had finished but the engine hadn't recorded the outcome. The engine finishes the open attempt with its stored result or failure, and fails it as interrupted only if nothing was stored.
  
  Adds `AttemptRuntime.finished`, `AttemptRuntime.recordResult`, `Executor.outcome`, and `StepExecutor.outcome`, and `Executor.isLive` is true for an attempt whose parent succeeded before its checkout was harvested. In `@usine/durable/testing`, a `StubStorage` task's `state` is a tagged value: `live`, `finished` with `report` and `result`, or `canceled`.
- 66f6b0b: Adds `GET /v1/providers` to the gateway admin API. It returns an `LlmProviderList` (`@usine/gateway/admin`) of the LLM providers the gateway has a credential for, with the credential kind, `api-key` or `subscription`, but never the credential; `@usine/core/worker` adds `GatewayCredentialKind`.
  
  `ChildSession` records `gatewayCredential`, `brainPool(brain, gatewayCredential)` takes it, and the new `sessionPool(session)` reads a recorded session's pool, so a Claude Code child whose gateway used an API key counts in `apiKeys` and is priced at the model's API rate. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`.
  
  At preflight, the SSH executor reads the gateway's Anthropic credential kind for a worker whose `llmProviders` lists `anthropic`. A gateway without an Anthropic credential fails preflight with a `gateway` capability error, and a gateway too old to respond keeps the Claude plan pool with a warning.
- 990612d: An operator message to the Pi parent places a hold, as on a child (ADR 0018, amendment of 2026-10-19). After the parent answers, it waits for another message or **Release parent** instead of ending the attempt; a steer places no hold, and a message to a parent that waits on a child is queued until the child returns.
  
  Adds `InterventionState.queued` to `@usine/core/attempt/channel`, with a second receipt that reports delivery or `InterventionRejected`, and `AttemptReport.answeredOperator` and `harvestedResult` to `@usine/durable/attempt-runtime`. An attempt whose parent ended on its answer to the operator, with no commit, pull request, or comment, fails with `AgentFailure`, and the runaway guard's wall-clock ceiling pauses while the parent is held.
- b601259: After an orchestrator restart, a reattached attempt's runaway guard resumes from its recorded totals instead of starting over, and sends each 80% warning at most once per attempt. If the guard can't read the transcript or unsupervised time, it cancels the parent task, records the salvage, and fails the attempt with an `InfraFailure`.
  
  Adds `AttemptChannel.Sink.transcript` to `@usine/core`, which the engine reads from the run tables, and `AttemptRuntime.recordUnsupervised`, `AttemptRuntime.unsupervised`, `AttemptRuntime.attached`, and `StubStorage.unsupervised` to `@usine/durable`. A wall-clock guard records its unsupervised time every 30 seconds, so a crash loses at most 30 seconds, and the wall clock starts once the launch registers the attempt's session.
- ebfb373: A child's harness failure, such as a failed Codex turn, ends the attempt with `AgentFailure` and no longer suppresses the item. Only `[usine:blocked]` ends an attempt with `BlockedFailure`.
  
  `@usine/agents/runtime` adds `FAILED_MARKER` (`[usine:failed]`), which `reportText` writes for an `AgentResultError` and `reportedOutcome` reads back. The `@usine/durable/testing` stub child adds `fail`, and the run page's reader hides the marker.
- 6764fa7: The run page shows the worker, duration, token usage per pool and session, and why each attempt began. The outline groups consecutive turns of one session, and its error count includes only what the run ended with or the operator must read.
  
  Adds `AttemptStart` to `@usine/core/attempt/start` (`StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry`, `StartedByInfraRetry`, `StartedAfterRestart`), `Attempt.start`, `Attempt.reattachedAt`, `SessionTokensUpdated.costUsd`, and `brainPool`. `RunEngine.retry` takes a `RetryRequest`, `Operator.retry` takes the loaded instance, `RunDetailView` adds `worker`, `duration`, and `usage` (`RunUsageView`), and a migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`.
- 761099a: Adds `StuckStepReports` to `@usine/durable/harness`: how many identical reports without a commit mark a step as stuck (default 1,000).
- 10ab5af: A durable conversation document that no longer reads back fails only its attempt, with an `InfraFailure` that states the reason, instead of stopping the harness. `DurableHarness.resume` takes a `BeforeResume` step that runs on every opened harness before its tasks resume, including after a reopen.

### Patch Changes

- 3ed742f: An agent's `[usine:blocked]` report ends the attempt with the new `BlockedFailure` instead of `AgentFailure`, and the loop suppresses the item as after a `QuestionFailure`, so it doesn't open a run on the agent's own blocker comment. Another item change, a non-matching sighting, a retry, or `RunEngine.resolveFailure` lifts the suppression.
  
  Adds `AgentBlockedError` to `@usine/agents/runtime` and `BlockedFailureView` to `@usine/orchestrator/operator`.
- 6672585: `AttemptRuntime.isLive` returns false for an attempt whose task was canceled, even if its relay failed before the terminal envelope, so orchestrator startup no longer cancels that task again. A task that finished without an attached relay stays live until `execute` relays its terminal envelope.
- 7a6d96f: Adds TSDoc to every field of the public schema classes and interfaces of `@usine/durable`, and to `DurableHarness.models` and `DurableHarness.defaultModel`.
- 14c2d3c: `DurableHarness` logs the first report of each pi-durable failure, then the repeat count at most every five seconds. After 1,000 reports of one failure with no commit, the harness reopens the storage; if it gets stuck again within a minute, it stops and running attempts fail with an `InfraFailure`. `HarnessListener` adds `onStop`.
- d3942c0: Fixes `AttemptRuntime.notify` dropping a worker notice sent before the attempt's relay or parent starts; it records the notice after `Started`.
- b49ed35: `harvestFacts` records the comments and reviews that the attempt's bot login posted on its run's item since the worker prepared the checkout, as `Comment` facts. An attempt whose parent's last turn answered the operator succeeds if it posted a comment or review on the item, instead of failing with `AgentFailure`.
  
  Adds `BotLogin` to `@usine/core/worker`, `Comment.kind` (`CommentKind`) to `@usine/core/step/result`, `RunSpec.preparedAt` and `RunSpec.botLogin` to `@usine/core/attempt/channel`, and `CheckoutRequest.botLogin` to `@usine/executor`. `stepExecutorLayer` and the local, SSH, and exe.dev engine compositions require `GitHubApp`.
- 8e2da2d: An agent asks the operator a question by starting its final answer with `[usine:question]`. The attempt ends with the new `QuestionFailure`, which never retries automatically, and **Needs you** shows the question; a child's question is passed to the parent as `AgentQuestionError`.
  
  The loop then suppresses the item: the next item state returns the new `Suppressed` submission result and opens no run. Another item change, a non-matching sighting, a retry, or marking the question answered with `RunEngine.resolveFailure` lifts the suppression.
- e518906: Pins `@earendil-works/pi-codemode` to 1.1.0, next to `@earendil-works/pi-coding-agent` 1.1.0. Fixes a `SyntaxError` in `@usine/durable/live`, the executor and orchestrator entry points that load it, and `usine up` when a plain install resolved pi-codemode 1.3.0, which doesn't export `MCP_TYPESCRIPT_PREAMBLE`.
- 7078fa8: Pins the `@earendil-works` packages `pi-agent-core`, `pi-mcp`, `pi-telemetry`, and `pi-tui` to 1.1.0, matching `pi-coding-agent`, so a plain install loads one copy each of `pi-ai` and `chord`.
- 4d4c6bd: Pins `@effect/platform-node-shared` to the version of `effect` these packages pin. Fixes `ERR_MODULE_NOT_FOUND` from the Node entry points and the `usine` command when a plain install resolved a release that needs a newer `effect`.
- 5870baf: Rewrites error messages, API errors, CLI output, and web UI text in the Google developer documentation style. Messages name the problem and the fix, use lowercase common nouns, and quote names from configuration, such as `worker "eu-one"`. The startup line in setup mode is now `usine is running in setup mode at …`.
- a999ca0: A released parent's reply to the release guidance doesn't count as answering the operator, so `AttemptReport.answeredOperator` stays false.
- 42780b5: A retried attempt starts from the run's current revision, the default branch tip for an issue run, and rebases the previous attempt's salvage onto it. A salvage with no changes is dropped, and one that doesn't rebase cleanly stays on its branch and appears in the new `RunSpec.conflictingSalvage` and `Started.conflictingSalvage`, which the prompt and transcript mention.
- Updated dependencies [0fc7e8f]
- Updated dependencies [3ed742f]
- Updated dependencies [0275eff]
- Updated dependencies [425e240]
- Updated dependencies [8292038]
- Updated dependencies [acef6eb]
- Updated dependencies [a3a230c]
- Updated dependencies [d062b4d]
- Updated dependencies [af28e0e]
- Updated dependencies [759db71]
- Updated dependencies [caf041d]
- Updated dependencies [31137ed]
- Updated dependencies [af28e0e]
- Updated dependencies [66f6b0b]
- Updated dependencies [a55d12d]
- Updated dependencies [b49ed35]
- Updated dependencies [91e2b70]
- Updated dependencies [990612d]
- Updated dependencies [8e2da2d]
- Updated dependencies [01306e6]
- Updated dependencies [5519ca3]
- Updated dependencies [9b78093]
- Updated dependencies [458033e]
- Updated dependencies [e518906]
- Updated dependencies [7078fa8]
- Updated dependencies [5870baf]
- Updated dependencies [71c8b48]
- Updated dependencies [99164fa]
- Updated dependencies [b601259]
- Updated dependencies [2729e91]
- Updated dependencies [07a4145]
- Updated dependencies [ebfb373]
- Updated dependencies [0799f4f]
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
  - @usine/agents@0.4.0
