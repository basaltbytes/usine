---
"@usine/core": minor
"@usine/agents": minor
"@usine/durable": minor
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": patch
---

An Attempt reports when its Worker stops answering or a child cannot reach its model provider. Nothing stops or fails the Attempt on either report.

`@usine/core/attempt/channel` adds the outbound payloads `WorkerUnresponsive` (the Worker, when it last answered, and what the probe saw) and `WorkerResponsive`, and their union `WorkerNotice`. `@usine/core/agent/session` adds the session events `ProviderRetrying` (the harness's report and the retries in the turn so far) and `ProviderRecovered`, with the `ProviderRetries` count.

The Codex child reports each app-server `error` notification with `willRetry: true` for its current turn as `ProviderRetrying`, and the next notification of the same turn as `ProviderRecovered`. The Claude Code child does the same for each `api_retry` message and the next assistant message. Each retry is also logged as a warning.

`AttemptRuntime` in `@usine/durable/attempt-runtime` adds `notify`, which records a `WorkerNotice` in the Attempt's transcript after everything relayed before it. The stub runtime in `@usine/durable/testing` records it too.

While an Attempt runs on an SSH or exe.dev Worker, the executor runs `true` on the Worker's machine over a new SSH connection every minute, with `ConnectTimeout=20` and a 45-second bound. The first probe without an answer records `WorkerUnresponsive` and logs a warning, each further one logs another warning, and the first answer after that records `WorkerResponsive`.

`TranscriptPayload` in `@usine/orchestrator/operator` includes `WorkerUnresponsive` and `WorkerResponsive`.

The Run page's conversation shows these reports as yellow lines, with a child's consecutive retries on one line that keeps the count and the latest message. While one is open, the current activity on the Run page and in the Run drawer says what has not answered and since when. Needs you does not change.
