---
"@usine/agents": minor
---

Harness runtimes run structured completions. `HarnessRuntime.complete(spec, prompt, output)` sends one prompt and returns a `Completion`: the value that the `output` schema decodes, and its usage as a `SessionTokensUpdated` that records the brain and billing pool. A completion saves no conversation and returns no session reference. Claude Code runs `query()` with no built-in tools and an output format, Codex runs an ephemeral, read-only thread with an output schema, and Pi sends one model request through its credential routes with an output tool. `@usine/agents/harness/contract` exports `Completion`, `CompletionOutput`, and `CompletionError`, which carries the tokens spent before a failure and a `reason`: `CompletionInvalid`, `CompletionRefused`, `AgentCapacityError`, or `SessionOperationError`.

A runtime from `Harnesses` admits a completion for a role that returns a structured value and keeps no conversation, accepts a `Schema.Class` or identified output schema, refuses an output schema whose JSON form isn't an object, and fails a completion after 10 minutes. `open` refuses such a role. Claude Code, Codex, and Pi declare `structured-output` and `ephemeral`, which the new `structured-result` and `ephemeral` contract scenarios prove. `PiSdk` adds `complete`.
