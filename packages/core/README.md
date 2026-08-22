# @usine/core

Domain model for [usine](https://github.com/basaltbytes/usine), an agent-agnostic software factory: the Event → Run → Step → Attempt vocabulary every other block types against.

Everything lives in the `lifecycle` cluster — how one piece of work moves through the engine: a deduplicated Event opens a Run, the Run's named Step is tried as Attempts, and the state machine closes it. The attempt-channel envelope schema arrives later as a sibling cluster.

## What each export is

| Export | Kind |
| --- | --- |
| `Event`, `Run`, `Step`, `Attempt` | Entities — the four ledger rows, identity plus validated construction |
| `EventId`, `RunId`, `AttemptId` | Value objects — branded ids; identities that cannot be swapped for each other |
| `DedupKey`, `LoopName`, `StepName`, `AttemptNumber` | Value objects — branded primitives carrying a domain constraint |
| `RunState.*`, `CancelReason`, `Attempt.Outcome` | State value objects — discriminated unions, each state carrying exactly its own data |
| `RunState.awaitApproval/start/succeed/fail/retry/cancelByOperator/supersede/revoke` | Typestate transitions — each accepts only the states it is legal on, so an illegal transition is a compile error |
| `InfraFailure`, `AgentFailure`, `RunawayFailure` | Typed errors — the attempt-failure taxonomy |
| `AttemptFailure.isAutoRetryable`, `Attempt.shouldAutoRetry` | Derivers — pure decision functions stating the auto-retry law (class rule; class rule capped by attempt count) |

The run state machine is `pending → waiting → running → succeeded / failed / canceled`, with `failed → running` on operator retry. The failure taxonomy separates infra failures (the only auto-retryable class, capped), agent failures (always wait for the operator), and the runaway guard tripping (never auto-retried).

Everything is 0.x: APIs change without notice while the engine grows. `effect` is a peer dependency — supply it yourself at the pinned version.
