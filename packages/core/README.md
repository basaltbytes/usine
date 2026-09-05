# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against, plus the shared instance, repository, worker, and agent values.

Import each domain concept from its owning subpath. Identities, records, and operations share that domain module.

| Subpath | Exports |
| --- | --- |
| `@usine/core/event` | `Event`, `EventId`, `DedupKey` |
| `@usine/core/run`, `@usine/core/run/state` | `Run`, `RunId`; the run state machine as a tagged union with typestate transitions (`RunState.start`, `RunState.supersede`, ...) |
| `@usine/core/step`, `@usine/core/step/result` | `Step`, `StepName`; `StepResult` and its facts (`Commit`, `PullRequest`, `Comment`) |
| `@usine/core/attempt` | `Attempt`, `AttemptId`, `AttemptNumber`, `AttemptTask`, `shouldAutoRetry` |
| `@usine/core/attempt/outcome` | `AttemptSucceeded`, `AttemptFailed`, `AttemptCanceled`, `AttemptOutcome` |
| `@usine/core/attempt/failure` | `InfraFailure`, `AgentFailure`, `RunawayFailure`, `ChildSessionBudgetFailure`, `AttemptFailure`, `isAutoRetryableFailure` |
| `@usine/core/attempt/channel` | The protocol-v4 attempt channel: `RunSpec`, `Start`, the envelopes, and the `admit` reducer. Import it as a namespace (`AttemptChannel.Started`) |
| `@usine/core/agent`, `@usine/core/agent/brain`, `@usine/core/agent/session` | `Agent`, `AgentName`, `AgentPersona`, parent-model resolution; `BrainSpec`, `ModelId`, `Harness`, `Effort`; `AgentSessionId`, session descriptors, `AgentSessionEvent`, `ChildSessionBudget`, `ChildSessionCount` |
| `@usine/core/repository` | `RepositoryName`, `RepositoryRevision`, `CommitSha`, `splitRepositoryName`, `canonicalRepositoryName` |
| `@usine/core/worker`, `@usine/core/item`, `@usine/core/loop`, `@usine/core/instance` | `WorkerName`, `WorkerKind`; `ItemKey`, `ItemNumber`; `LoopName`, `ApprovalRequirement`; `InstanceDirectory` |

Branded schemas are exported under their brand name, and each has an `export type` twin of the same name so the name works in type positions too.

`PullRequest` and `Comment` facts use `URL` values in memory and URL strings in JSON, so Step results round-trip through the Attempt channel and durable storage.

The run state machine is `pending → waiting → queued → running → succeeded / failed / canceled`, with `failed → running` on operator retry. The failure taxonomy separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), runaway guard failures, and exhausted child-session budgets. Guard failures never auto-retry.

Each Attempt records the child `BrainSpec` and effective Pi parent model used for that try. The attempt channel includes immutable repository, payload, task, agent context, and child-session budget in its `Start` frame; outbound `SessionEvent` envelopes retain parent and first-level child session identity.

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.

Import `CycleLimit`, `CycleCount`, `LoopCycleCount`, and `CycleBudgetAsk` from `@usine/core/cycle-budget`. An Item-level Ask records the exhausted Loop, its limit, and participating Loops’ admitted and completed Runs; it can exist before another Run is opened.
