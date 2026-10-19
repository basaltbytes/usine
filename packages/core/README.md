# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against, plus the shared instance, repository, worker, and agent values.

Import each domain concept from its owning subpath. Identities, records, and operations share that domain module.

| Subpath | Exports |
| --- | --- |
| `@usine/core/event` | `Event`, `EventId`, `DedupKey` |
| `@usine/core/run`, `@usine/core/run/state` | `Run`, `RunId`; the run state machine as a tagged union with typestate transitions (`RunState.start`, `RunState.supersede`, ...) |
| `@usine/core/step`, `@usine/core/step/result` | `Step`, `StepName`; `StepResult` and its facts (`Commit`, `PullRequest`, `Comment`) |
| `@usine/core/step/harvest` | `harvestFacts`, `HarvestError`: the commits and pull requests an Attempt's checkout holds once its agent finished, and the comments and reviews the Attempt posted on its Run's Item, read through a caller-supplied `git`/`gh` runner |
| `@usine/core/attempt` | `Attempt`, `AttemptId`, `AttemptNumber`, `AttemptTask`, `shouldAutoRetry` |
| `@usine/core/attempt/outcome` | `AttemptSucceeded`, `AttemptFailed`, `AttemptCanceled`, `AttemptOutcome` |
| `@usine/core/attempt/failure` | `InfraFailure`, `DefectFailure`, `AgentFailure`, `RunawayFailure`, `ChildSessionBudgetFailure`, `AttemptFailure`, `isAutoRetryableFailure` |
| `@usine/core/attempt/salvage` | `SalvageRef`, `salvageRefFor`, `SalvagePushed`, `SalvageRetained`, `AttemptSalvage`, `AttemptRecovery` |
| `@usine/core/attempt/channel` | The attempt channel: `RunSpec`, the versioned envelopes, the `Sink` that stores them, and the `admit` reducer. Import it as a namespace (`AttemptChannel.Started`) |
| `@usine/core/agent`, `@usine/core/agent/brain`, `@usine/core/agent/session` | `Agent`, `AgentName`, `AgentPersona`, parent-model resolution; `BrainSpec`, `ModelId`, `Harness`, `Effort`; `AgentSessionId`, session descriptors, `AgentSessionEvent`, `ChildSessionBudget`, `ChildSessionCount` |
| `@usine/core/agent/capability` | `HarnessCapability`, `HarnessReady`, `HarnessUnavailableError`, and the credential-free `HarnessReadiness` preflight response |
| `@usine/core/repository` | `RepositoryName`, `RepositoryRevision`, `CommitSha`, `safeSegment`, `splitRepositoryName`, `canonicalRepositoryName` |
| `@usine/core/worker`, `@usine/core/item`, `@usine/core/loop`, `@usine/core/instance` | `WorkerName`, `WorkerKind`; `ItemKey`, `ItemNumber`; `LoopName`, `ApprovalRequirement`; `InstanceDirectory` |

Branded schemas are exported under their brand name, and each has an `export type` twin of the same name so the name works in type positions too.

`PullRequest` and `Comment` facts use `URL` values in memory and URL strings in JSON, so Step results round-trip through the Attempt channel and durable storage.

The run state machine is `pending → waiting → queued → running → succeeded / failed / canceled`, with `failed → running` on operator retry. The failure taxonomy separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), runaway guard failures, and exhausted child-session budgets. Guard failures never auto-retry.

`RunState.operatorActions(state)` returns approval, retry, failure-resolution, cancel, and run-again availability for operator views. A succeeded or canceled Run can run again: the operator opens a new Run for its Item state, recorded as `RunAgain` (`@usine/core/run/again`) with the Run it ran again and who asked. The command handlers enforce the same lifecycle through the typed transitions. Failure resolution is available only in the failed state; operator views also check whether the latest failed Attempt has already been resolved.

Each Attempt records the child `BrainSpec` and effective Pi parent model used for that try. `RunSpec` holds the immutable repository, payload, task, agent context, and child-session budget an Attempt's parent starts from; outbound `SessionEvent` envelopes retain parent and first-level child session identity.

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.

Import `CycleLimit`, `CycleGeneration`, `CycleCount`, `LoopCycleCount`, and `CycleBudgetAsk` from `@usine/core/cycle-budget`. An Item-level Ask records the exhausted Loop, its limit, and participating Loops’ admitted and completed Runs; it can exist before another Run is opened.

`DefectFailure` records a programmer defect captured at a boundary that needs a serializable Attempt outcome. It retains the original cause and never qualifies for automatic retry.

`SessionStarted.harnessSession` optionally records a `HarnessSession`: the harness-native `HarnessSessionId` and worker working directory (`cwd`). Missing metadata in older transcripts decodes to `Option.none()`; usine's session identity remains separate.

Envelopes carry `PROTOCOL_VERSION` (7), which the transcript store uses to read envelopes stored by earlier versions. Version 7 added the previous Attempt's pushed salvage to `RunSpec` (`resume`); version 6 added saved harness session metadata.
