---
"@usine/core": minor
"@usine/engine": minor
"@usine/agents": minor
"@usine/durable": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

The Run page shows where and how long a Run worked, what it used, and why each Attempt began, and its outline and error count read better on long Runs.

`@usine/core/attempt/start` adds `AttemptStart`: `StartedByEvent`, `StartedByRetry` and `StartedByEditAndRetry` with the operator login, `StartedByInfraRetry`, and `StartedAfterRestart`. `Attempt` carries `start` and `reattachedAt`. `SessionTokensUpdated` carries `costUsd`, the cumulative price the harness put on the session's usage, and `brainPool` names the billing pool a session's brain draws from.

`RunEngine.retry` takes a `RetryRequest` with the operator login and an optional edit-and-retry amendment. Each new Attempt records why it began, and a reattached Attempt records when. A migration adds `usine_attempts.start_json`, `usine_attempts.reattached_at`, and `usine_runs.next_start_json`, and records earlier first Attempts as begun from their Event. `TranscriptUsageQuery` returns each session's highest token report.

The Pi adapters and the durable parent relay add Pi's per-message price to `SessionTokensUpdated`, and the Claude Code child adds the Agent SDK's `costUSD`.

`RunDetailView` adds the newest Attempt's `worker`, the Attempts' `duration` (`RunDurationView`), and `usage` (`RunUsageView` with `PoolUsageView`, `SessionUsageView`, and `UsageCostView`): tokens per session, per pool, and for the Run, with a price where the pool has a dollar rate, marked as an estimate on the Claude plan and never given for the ChatGPT plan. `AttemptView` adds `start` and `reattachedAt`. `Operator.retry` takes the loaded instance so the retry records the `operator` login.

The web UI's Run header and drawer show the Worker and the Run's duration, and the Run page shows its tokens with a breakdown per pool and session. Each Attempt in the outline says why it began. The outline folds consecutive turns of one session into one entry and keeps blockers, questions, operator input, connectivity notices, and outcomes as their own entries. Its error count holds only what the Run ended with or the operator must read, and tool failures the Agent recovered from have their own quieter count.
