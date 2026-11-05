---
"@usine/agents": minor
"@usine/core": minor
"@usine/durable": minor
"@usine/executor": patch
"@usine/cloudflare": minor
"@usine/server": patch
---

Scope child environments and forwarded credentials to the launched harness. Saved child continuations exclude credential routes and billing metadata, and resolve the current credential kind at every launch. Refuse moved homes and changed Codex model provider IDs before starting another turn.

Add harness-owned login variables, continuation mismatch errors, and `HarnessSession.modelProvider`. Coordinator credentials use the shared `CredentialRoute` values through `credentials.route`. Cloudflare's `harnessEnvironment` accepts an `Option<Harness>` to select provider wiring or the base command environment.
