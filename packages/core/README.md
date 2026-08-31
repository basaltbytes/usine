# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against, plus shared instance and repository value objects.

Everything lives in the `lifecycle` cluster: a deduplicated Event opens a Run, the Run's named Step is tried as Attempts, and the state machine closes it.

## What each export is

| Export | Kind |
| --- | --- |
| `Event`, `Run`, `Step`, `Attempt` | Entities — the four ledger rows, identity plus validated construction |
| `EventId`, `RunId`, `AttemptId` | Value objects — branded ids; identities that cannot be swapped for each other |
| `DedupKey`, `ItemKey`, `LoopName`, `StepName`, `AttemptNumber` | Value objects — branded primitives carrying a domain constraint |
| `Instance.Directory`, `Repository.Name`, `Repository.Revision`, `Repository.CommitSha` | Shared value objects — paths and validated Git identities |
| `Worker.Name`, `Worker.Kind` | Value objects — a Worker identity and its local or exe.dev adapter kind |
| `Agent.Agent`, `Agent.BrainSpec` | Agent values — a named persona, its child brain, and optional Pi parent-model override |
| `Agent.SessionEvent` | Session events — typed parent or first-level child lifecycle, text, and tool events |
| `AttemptChannel.*` | Protocol values — the secret-free run spec, framed input, and protocol-v2 Attempt envelopes |
| `StepResult.*` | Result values — the final agent message plus commit, pull-request, and comment facts |
| `RunState.*`, `CancelReason`, `Attempt.Outcome` | State value objects — discriminated unions, including a distinct canceled Attempt outcome |
| `RunState.awaitApproval/start/succeed/fail/retry/cancelByOperator/supersede/revoke` | Typestate transitions — each accepts only the states it is legal on, so an illegal transition is a compile error |
| `InfraFailure`, `AgentFailure`, `RunawayFailure` | Typed errors — the attempt-failure taxonomy |
| `AttemptFailure.isAutoRetryable`, `Attempt.shouldAutoRetry` | Derivers — pure decision functions stating the auto-retry law (class rule; class rule capped by attempt count) |

The run state machine is `pending → waiting → running → succeeded / failed / canceled`, with `failed → running` on operator retry. The failure taxonomy separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), and the runaway guard tripping (never auto-retried).

Each Attempt records the child `BrainSpec` and effective Pi parent model used for that try. The attempt channel carries immutable repository, payload, task, and agent context in its `Start` frame; outbound `SessionEvent` envelopes retain parent and first-level child session identity.

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.
