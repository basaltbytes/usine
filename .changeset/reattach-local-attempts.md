---
"@usine/core": minor
"@usine/executor": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/run-host": patch
---

Run the local Worker's Pi parent in the orchestrator process as a durable task and reattach a live Attempt after an orchestrator restart instead of failing it and opening the next Attempt.

`@usine/executor/local` no longer launches the run host: it requires an `AttemptRuntime` (`@usine/durable/attempt-runtime`), drops `LocalExecutorOptions.runHost`, probes harnesses in-process with `@usine/agents/preflight` (override with `harnessReadiness`), and passes the Attempt's allowlisted environment with its credential configuration to the parent task, never the orchestrator's own. `Executor.isLive` reports whether an Attempt's parent task outlived a restart, `CheckoutRequest.reattach` makes `prepare` take over the existing worktree with fresh credentials, startup recovery leaves a live Attempt's worktree alone, and every other end of an Attempt cancels its parent task. The exe.dev adapter keeps the one-shot run host and always reports `isLive` false.

`RunStore.beginAttempt` gains a third outcome: an open Attempt whose parent task is live is reattached with its id and number and spends no retry. `StepExecutor.isLive` and `StepExecution.reattach` carry the decision to the executor, and a transcript envelope redelivered after a restart keeps its first stored copy.

`@usine/core/step/harvest` holds the commit and pull request harvesting that the run host and the local executor share, and `AttemptRecovery.open` marks Attempts without an outcome. The orchestrator's local `layer` requires the `AttemptRuntime` and builds it before the engine, so durable storage is open and resumed before Run recovery; `runtimeLayer` provides `@usine/durable/live` on the instance directory.
