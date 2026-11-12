---
"@usine/agents": minor
"@usine/durable": patch
"@usine/server": patch
---

Retry Codex and Pi usage limits after they reset, as Claude Code usage limits already are. A Codex turn that fails with `usageLimitExceeded` or `rateLimitExceeded` now fails the session with `AgentCapacityError`, whose `resetsAt` is the latest reset time among the used-up windows of Codex's last rate-limit snapshot. A Codex billing quota or a plan without Codex still fails the attempt for the operator. A Pi turn that ends on a ChatGPT plan limit, a shared ChatGPT subscription limit, or an HTTP 429 rate limit also fails with `AgentCapacityError`; a plan limit that states its wait resets after that wait. The Pi parent classifies the error that ends its turn the same way, and `@usine/agents/pi/refusal` exports that classifier as `piFailure`. The attempt fails with `ProviderCapacityFailure`, so the run retries after the reset, or after the default capacity delay when the harness reports no reset time, without the operator.
