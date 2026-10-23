# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against, plus the shared instance, repository, worker, and agent values.

Import each domain concept from its owning subpath. Identities, records, and operations share that domain module.

| Subpath | Exports |
| --- | --- |
| `@usine/core/event` | `Event`, `EventId`, `DedupKey` |
| `@usine/core/run`, `@usine/core/run/state` | `Run`, `RunId`; the run state machine as a tagged union with typestate transitions (`RunState.start`, `RunState.supersede`, ...) |
| `@usine/core/step`, `@usine/core/step/result` | `Step`, `StepName`; `StepResult` and its facts (`Commit`, `PullRequest`, `Comment`) |
| `@usine/core/step/harvest` | `harvestFacts`, `harvestPostedComments`, `HarvestError`, `HarvestSpec`, `AttemptWindowsRead`: the commits and pull requests an Attempt's checkout holds once its agent finished, and the comments and reviews the Attempt posted on its Run's Item (written by its bot login since the Worker prepared the checkout, ending with its Agent's signature, and posted inside its own window and in none of the windows of its Agent's other Attempts there, which the harvest reads through the caller's `AttemptWindowsRead` once GitHub has listed the comments), read through a caller-supplied `git`/`gh` runner |
| `@usine/core/attempt` | `Attempt`, `AttemptId`, `AttemptNumber`, `AttemptTask`, `shouldAutoRetry`, and when an Attempt was at work on its Item: `AttemptWindow`, `windowOf`, `windowHolds`, `windowsOverlap`, `AttemptWindows` |
| `@usine/core/attempt/outcome` | `AttemptSucceeded`, `AttemptFailed`, `AttemptCanceled`, `AttemptOutcome` |
| `@usine/core/attempt/failure` | `InfraFailure`, `DefectFailure`, `AgentFailure`, `RunawayFailure`, `ChildSessionBudgetFailure`, `AttemptFailure`, `isAutoRetryableFailure` |
| `@usine/core/attempt/salvage` | `SalvageRef`, `salvageRefFor`, `SalvagePushed`, `SalvageRetained`, `AttemptSalvage`, `AttemptRecovery`, `RecoverySink` (whose `windows` reads the windows a recovered Attempt's comment harvest needs) |
| `@usine/core/attempt/start` | Why an Attempt began: `StartedByEvent`, `StartedByRetry`, `StartedByEditAndRetry` (with the operator login), `StartedByInfraRetry`, `StartedAfterRestart`, `AttemptStart`, and `OperatorRetryStart` |
| `@usine/core/attempt/channel` | The attempt channel: `RunSpec`, the versioned envelopes, the `Sink` that stores them, reads them back (`transcript`), and reads the windows the harvest needs (`windows`), and the `admit` reducer. Import it as a namespace (`AttemptChannel.Started`) |
| `@usine/core/agent`, `@usine/core/agent/brain`, `@usine/core/agent/session` | `Agent`, `AgentName`, `AgentPersona`, parent-model resolution, `githubSignature` (the line an Agent ends its GitHub comments with); `BrainSpec`, `ModelId`, `Harness`, `Effort`; `AgentSessionId`, session descriptors, `AgentSessionEvent`, `ChildSessionBudget`, `ChildSessionCount` |
| `@usine/core/agent/capability` | `HarnessCapability`, `HarnessReady`, `HarnessUnavailableError`, and the credential-free `HarnessReadiness` preflight response |
| `@usine/core/repository` | `RepositoryName`, `RepositoryRevision`, `CommitSha`, `safeSegment`, `splitRepositoryName`, `canonicalRepositoryName` |
| `@usine/core/worker`, `@usine/core/item`, `@usine/core/loop`, `@usine/core/instance` | `WorkerName`, `WorkerKind`, `GatewayCredentialKind`; `ItemKey`, `ItemNumber`; `LoopName`, `ApprovalRequirement`; `InstanceDirectory` |

Branded schemas are exported under their brand name, and each has an `export type` twin of the same name so the name works in type positions too.

`PullRequest` and `Comment` facts use `URL` values in memory and URL strings in JSON, so Step results round-trip through the Attempt channel and durable storage.

The run state machine is `pending → waiting → queued → running → succeeded / failed / canceled`, with `failed → running` on operator retry. The failure taxonomy separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), runaway guard failures, and exhausted child-session budgets. Guard failures never auto-retry.

`RunState.operatorActions(state)` returns approval, retry, failure-resolution, cancel, and run-again availability for operator views. A succeeded or canceled Run can run again: the operator opens a new Run for its Item state, recorded as `RunAgain` (`@usine/core/run/again`) with the Run it ran again and who asked. The command handlers enforce the same lifecycle through the typed transitions. Failure resolution is available only in the failed state; operator views also check whether the latest failed Attempt has already been resolved.

Each Attempt records the child `BrainSpec` and effective Pi parent model used for that try. `RunSpec` holds the immutable repository, payload, task, agent context, and child-session budget an Attempt's parent starts from; outbound `SessionEvent` envelopes retain parent and first-level child session identity.

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.

Import `CycleLimit`, `CycleGeneration`, `CycleCount`, `LoopCycleCount`, and `CycleBudgetAsk` from `@usine/core/cycle-budget`. An Item-level Ask records the exhausted Loop, its limit, and participating Loops’ admitted and completed Runs; it can exist before another Run is opened.

`DefectFailure` records a programmer defect captured at a boundary that needs a serializable Attempt outcome. It retains the original cause and never qualifies for automatic retry.

An `Attempt` records why it began (`start`, none for a later Attempt begun before usine recorded it) and when a restart last reattached it (`reattachedAt`).

`AttemptWindow` is when an Attempt was at work on its Run's Item, from its record: `startedAt` through `endedAt`, none while it is open. `windowOf(attempt)` reads it from an `Attempt`, and is none for an Attempt that ended before end times were recorded. GitHub records times to the second, so `windowHolds(window, at)` opens a window at the second its Attempt started, and `windowsOverlap` says whether GitHub can record a time two windows both hold. Every Attempt on a local or SSH Worker writes as the same App, so a write in two Attempts' windows belongs to neither. The Run reader applies this rule to the App's changes, and the harvest to the comments an Attempt signed: it keeps one only when it was posted since the Worker prepared the checkout, its creation or a review's submission, inside the Attempt's own window, and in none of the windows of the Agent's other Attempts that overlap it on the Item. `AttemptWindows` holds those windows as the orchestrator's records give them when read: `own`, and `overlapping`. The harvest reads them through the caller's `AttemptWindowsRead` once GitHub has listed the comments. An Attempt that started while the harvest ran is therefore among them. So is the end the orchestrator recorded when it closed this Attempt before the harvest, as a cancel does before the executor stops: a comment posted after that end is not this Attempt's, and an Attempt that started after it does not overlap this one.

`SessionTokensUpdated` carries a session's cumulative `TokenCount` and, as `costUsd`, the `UsdAmount` its harness priced that usage at: Pi from its model catalog, Claude Code from the Agent SDK's prices. Codex prices nothing, and transcripts recorded before prices were decode to `Option.none()`. `ChildSession.gatewayCredential` records the `GatewayCredentialKind` the Gateway in front of the child's Worker paid its model requests with; it is none when the child paid with its harness's own login, and in transcripts recorded before it was. `brainPool(brain, gatewayCredential)` names the billing pool a started session draws from, and `sessionPool(session)` reads it from a recorded session: a Claude Code child is in `apiKeys` when its Gateway paid with an API key and in `claudePlan` otherwise (ADR 0013, ADR 0021).

`SessionStarted.harnessSession` optionally records a `HarnessSession`: the harness-native `HarnessSessionId` and worker working directory (`cwd`). Missing metadata in older transcripts decodes to `Option.none()`; usine's session identity remains separate.

Envelopes carry `PROTOCOL_VERSION` (7), which the transcript store uses to read envelopes stored by earlier versions. Version 7 added the previous Attempt's pushed salvage to `RunSpec` (`resume`); version 6 added saved harness session metadata.
