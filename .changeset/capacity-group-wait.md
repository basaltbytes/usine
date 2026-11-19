---
"@usine/agents": minor
"@usine/core": minor
"@usine/engine": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A provider capacity refusal, such as a subscription usage limit, no longer fails a run. A run waits until the reset time that the harness reports. When the harness reports none, the run waits 5, 15, and 30 minutes, then 60 minutes between tries, with no limit on the total wait. Before, three tries a few minutes apart ended every run that needed the provider, even when the limit lasted hours.

One refusal marks the capacity group of the refused attempt, its harness and model on its worker, as at capacity. Runs that need the group release their worker slot and wait without starting an attempt. At each next try, one attempt tests the group. The provider's first answer in that attempt, or the attempt's end without a refusal, releases the other runs; a notice that the harness writes itself, such as Claude Code's usage-limit message, isn't an answer. Runs on another harness, model, or worker keep running. Each group backs off after its own refusals, and a run waits for the group of its latest refusal. After a restart, each waiting run registers its refusals in that group again from the stored attempts.

Needs attention shows one entry for each capacity group at capacity (`ProviderCapacityNeed`), with the time the group started refusing, its next try, and the number of waiting runs. A waiting run, including one that has no attempt yet, shows the next try of its group. **Retry** on a waiting run starts its next attempt now, and that attempt tests the group; **Cancel run** stops the wait.

- `@usine/agents`: a Claude Code usage limit without a `rejected` rate-limit report takes the latest reset time of the allowance windows that the session's reports show used up, by the same rule as Codex. Claude Code, Codex, and Pi sessions report `ProviderAnswered` at the first answer of their model provider in each harness process.
- `@usine/core/agent/session`: `ProviderAnswered` reports a model provider's first answer, and `usedUpUntil` returns when the used-up rate-limit windows reset.
- `@usine/core/attempt`: `shouldAutoRetry` takes the earlier attempts, always retries a `ProviderCapacityFailure`, and leaves capacity refusals out of the `InfraFailure` attempt cap. `pendingProviderRetry` has no attempt cap, waits `capacityBackoff` of the run's consecutive refusals, and keeps the latest reset time that they report. `capacityRefusal` returns the refusal that ended an attempt. `ProviderRetry.nextAttempt` accepts attempt 1, for a run that waits for its group before its first attempt.
- `@usine/engine/engine`: `RunEngine.capacityWaits` lists the groups at capacity as `CapacityWait`, keyed by `CapacityGroup` and `capacityGroupKey`. `RunEngine.retry` of a run that waits after a capacity refusal, or that waits for its group without an attempt, starts its next attempt.
- `@usine/orchestrator/operator`: `NeedView` includes `ProviderCapacityNeed`. A run's `providerRetry` is at the next try of its capacity group, also for a run that waits for the group without a refused attempt, and `canRetry` is true while the run waits.
