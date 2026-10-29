# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine): event, run, step, and attempt types for every other block, plus shared instance, repo, worker, and agent values.

0.x APIs change without notice. Supply the peer dependency `effect` at the pinned version.

## Subpaths

| Subpath | Exports |
| --- | --- |
| `@usine/core/event` | `Event`, `EventId`, `DedupKey` |
| `@usine/core/run`, `@usine/core/run/state` | `Run`, `RunId`; the run state machine as a tagged union with typestate transitions (`RunState.start`, `RunState.supersede`, and others) |
| `@usine/core/step`, `@usine/core/step/result` | `Step`, `StepName`; `StepResult` and its facts (`Commit`, `PullRequest`, `Comment`) |
| `@usine/core/step/harvest` | `harvestFacts`, `harvestPostedComments`, `HarvestError`, `HarvestSpec`, `AttemptWindowsRead`: the commits and pull requests in an attempt's finished checkout, and the comments and reviews it posted on its item, read with the caller's `git`/`gh` runner |
| `@usine/core/attempt` | `Attempt`, `FailureResolution` (the time and operator of a failure resolution), `AttemptId`, `AttemptNumber`, `AttemptTask`, `OutOfMemoryKills` (the processes the kernel killed in an attempt's containers for memory), `ContainerOutOfMemoryKills` (those of one container, by `ContainerId`), `totalOutOfMemoryKills`, `shouldAutoRetry`, `MAX_AUTO_ATTEMPTS`, `ProviderRetry`, `pendingProviderRetry`, and `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, `AttemptWindows` |
| `@usine/core/attempt/outcome` | `AttemptSucceeded`, `AttemptFailed`, `AttemptCanceled`, `AttemptOutcome` |
| `@usine/core/attempt/failure` | `GitHubPushFailure`, `InfraFailure`, `DefectFailure`, `ProviderCapacityFailure`, `AgentFailure`, `RunawayFailure`, `ChildSessionBudgetFailure`, `AttemptFailure`, `isAutoRetryableFailure` |
| `@usine/core/attempt/salvage` | `SalvageRef`, `salvageRefFor`, `SalvagePushed`, `SalvagePartlyPushed` (pushed work whose checkout keeps the files that the push left out), `SalvageRetained`, `SalvageRejected` (a push that the remote refused for good), `AttemptSalvage`, `AttemptRecovery` (its `rejected` is the recorded `SalvageRejected`, whose commit recovery doesn't push again), `RecoverySink` (its `windows` reads the windows a recovered attempt's harvest needs) |
| `@usine/core/attempt/start` | Why an attempt started: `StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry` (with the operator login), `StartedByInfraRetry`, `StartedByProviderRetry`, `StartedAfterRestart`, `AttemptStart`, `OperatorRetryStart` |
| `@usine/core/attempt/channel` | `RunSpec`, versioned envelopes, the `Sink` (stores envelopes, records the salvage, comments, and out-of-memory kills, reads the `transcript` and the harvest's `windows`), and the `admit` reducer. Import as a namespace (`AttemptChannel.Started`). |
| `@usine/core/agent`, `/agent/brain`, `/agent/session` | `Agent`, `AgentName`, `AgentPersona`, parent model resolution, `githubSignature` (the last line of an agent's GitHub comments); `BrainSpec`, `ModelId`, `Harness`, `Effort`; `AgentSessionId`, session descriptors, `AgentSessionEvent`, `ChildSessionBudget`, `ChildSessionCount` |
| `@usine/core/agent/capability` | `HarnessCapability`, `HarnessReady`, `HarnessUnavailableError`, and the credential-free `HarnessReadiness` preflight response |
| `@usine/core/repository` | `RepositoryName`, `RepositoryRevision`, `CommitSha`, `safeSegment`, `splitRepositoryName`, `canonicalRepositoryName` |
| `@usine/core/worker`, `/item`, `/loop`, `/instance` | `WorkerName`, `WorkerKind`, `GatewayCredentialKind`, `ContainerId`; `ItemKey`, `ItemNumber`; `LoopName`, `ApprovalRequirement`; `InstanceDirectory`, `InstanceId` |
| `@usine/core/cycle-budget` | `CycleLimit`, `CycleGeneration`, `CycleCount`, `LoopCycleCount`, `CycleBudgetAsk` |

Branded schemas are exported under their brand name, as a value and a type. `PullRequest` and `Comment` facts use `URL` values in memory and strings in JSON, so step results round-trip through the channel and durable storage.

## Runs

The run state machine is `pending → waiting → queued → running → succeeded / failed / canceled`, plus `failed → running` on operator retry. `RunState.operatorActions(state)` returns which of approval, retry, failure resolution, cancel, and run again apply. Command handlers share these typed transitions.

- Run again opens a new run for the item state of a succeeded or canceled run. `RunAgain` (`/run/again`) records the original run and who asked.
- Failure resolution applies only in the failed state; operator views also hide it once the latest failed attempt is resolved.

An item-level `CycleBudgetAsk`, which can exist before another run opens, records the exhausted loop, its limit, and the participating loops' admitted and completed runs.

## Attempts

Each attempt records its child `BrainSpec`, its effective Pi parent model, why it started (`start`, none for attempts from before usine recorded it), when a restart last reattached it (`reattachedAt`), and how many processes the kernel killed in its containers for memory, with the memory limit of the last container that had kills (`outOfMemory`, none if it killed none or the attempt ran without a container). A reattachment runs the attempt in a new container, so `outOfMemory` adds up the kills of each container. `RunSpec` is the immutable repo, payload, task, agent context, and child-session budget that the parent starts from.

Infrastructure failures (`InfraFailure`) and provider capacity refusals (`ProviderCapacityFailure`) retry automatically, up to a cap. Agent failures wait for the operator. Runaway guard failures, exhausted child-session budgets, and `DefectFailure` never retry automatically; `DefectFailure` records a defect caught at a boundary that needs a serializable outcome, with its original cause.

`GitHubPushFailure` records the repository, refused ref, and diagnostic for an HTTP 403 on a push with a single-repository installation token. It does not retry automatically. `SalvageRetained.pushFailure` preserves this failure alongside the retained checkout; older salvage records decode it as `None`.

`Attempt.failureResolution` records when an operator marked its failure resolved and the configured operator login, if any. It stays with that attempt across later retries. Older resolutions without a recorded time have `None`.

## Attempt windows

`AttemptWindow` is when an attempt worked on its run's item: `startedAt` to `endedAt` from its record, with no end while open. `windowOf(attempt)` returns none for an attempt that ended before usine recorded end times. `windowHolds(window, at)` opens a window at its start second, since GitHub records times to the second. `windowsOverlap` says whether GitHub can record a time inside both windows.

Attempts on local and SSH workers all write as the same GitHub App, so a write inside two attempts' windows belongs to neither, in the run reader and in the harvest. The harvest keeps a comment only if the bot login wrote it with the agent's signature, after the worker prepared the checkout (creation, or a review's submission), inside the attempt's own window, and in no window of the agent's other overlapping attempts.

The harvest reads `AttemptWindows` (`own`, `overlapping`) through `AttemptWindowsRead` after GitHub lists the comments, so they include attempts started during the harvest and any end the orchestrator recorded first, as a cancel does before the executor stops. Comments after that end, and attempts started after it, don't count.

## Sessions and usage

Outbound `SessionEvent` envelopes keep parent and first-level child session identity.

`SessionTokensUpdated` has a session's cumulative `TokenCount` and, as `costUsd`, the `UsdAmount` its harness priced it at: Pi from its model catalog, Claude Code from the Agent SDK. Codex sets no price. Older transcripts decode it to `Option.none()`.

`ChildSession.gatewayCredential` is the `GatewayCredentialKind` the gateway in front of the child's worker used for its model requests: none if the child used its harness's login, and in older transcripts. `brainPool(brain, gatewayCredential)` returns a started session's billing pool; `sessionPool(session)` reads a recorded one's. A Claude Code child is in `apiKeys` if its gateway used an API key, otherwise in `claudePlan`; a Codex child is in `apiKeys` if its gateway used an API key, otherwise in `chatgptPlan` (ADR 0013, ADR 0021). `GatewayLlmProvider` is `anthropic` (Claude Code) or `openai` (Codex).

`PoolRateLimitsUpdated.login` records the provider-reported `PoolLogin` with a rate-window snapshot. Older events and providers that omit the login decode it as `Option.none()`.

The optional `SessionStarted.harnessSession` (`HarnessSession`) records the harness's `HarnessSessionId` and the worker `cwd`, apart from usine's session identity. Its optional `home` is the directory the harness saved the session in when the attempt set one, Codex's `CODEX_HOME`. Older transcripts decode `harnessSession`, and a `HarnessSession` without `home`, to `Option.none()`.

Envelopes include `PROTOCOL_VERSION` (7), which the transcript store uses to read older envelopes. Version 7 added the previous attempt's pushed salvage to `RunSpec` (`resume`); version 6 added harness session metadata.

`@usine/core/upgrade` defines release versions, upgrade channels and modes, request timing, and the durable helper outcome shared by configuration and operator surfaces. Rolled-back outcomes include `failureStage`: `install`, `health-check`, or `unknown` for records written before the helper recorded the stage.

`@usine/core/worker` also exports `BoatSnapshotName` and `TailnetAddress`, which validate saved snapshot names and Tailscale IPv4 addresses.

`WorkerUnresponsive.unansweredProbes` records consecutive unanswered probes; older notices decode to 1. `WORKER_UNRESPONSIVE_PROBES` is the shared attention threshold of 3. The executor reports at that threshold so consumers can distinguish persistent outages from the first missed probe.

`ProvisionerTimings` in `/worker` validates provisioner waits and check intervals in seconds, including ordered creation backoff bounds. Defaults are 600 seconds for SSH, 30 to 600 seconds for backoff, and 86400 seconds between machine checks.

`ProviderCapacityFailure` records a temporary model provider refusal. It permits an automatic retry under the same attempt cap as `InfraFailure`. `pendingProviderRetry` derives the next attempt number, provider message, and earliest start from a running run's last failed attempt: two minutes after attempt 1 and five after attempt 2. `StartedByProviderRetry` distinguishes these starts from infrastructure retries.

## Project identities

`ProjectId` from `@usine/core/project` is a lowercase slug of letters, digits, and separating hyphens. Project-owned loops use `project/loop` as their `LoopName`; repository identities remain independent of project membership.

## Member authentication

Authenticated operator actions use `ActingMember` and `requestActor` from `@usine/core/operator`. Operator cancellations record the member login in `OperatorCanceled.by`; older cancellations decode with no actor. The approval channel is `ui`.
