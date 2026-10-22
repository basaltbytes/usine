---
"@usine/core": minor
"@usine/gateway": minor
"@usine/orchestrator": minor
"@usine/durable": minor
"@usine/executor": minor
"@usine/agents": patch
---

The gateway's admin API reports the LLM providers it holds a credential for. `GET /v1/providers` answers with an `LlmProviderList` (`@usine/gateway/admin`): each provider with the kind of its credential, `api-key` or `subscription`, and never the credential itself. It reads the providers in force, so the answer follows a reload. `@usine/core/worker` adds `GatewayCredentialKind`, the two kinds.

`ChildSession` records `gatewayCredential`, the kind of credential the Gateway in front of the child's Worker paid its model requests with; it is none for a child that paid with its harness's own login and in transcripts recorded before it existed. `brainPool(brain, gatewayCredential)` takes that kind, and the new `sessionPool(session)` reads the pool from a recorded session: a Claude Code child its Gateway paid with an API key is in `apiKeys`, every other Claude Code child in `claudePlan`. The orchestrator's `RunUsageView` and Task usage use `sessionPool`, so those children are priced as API-key usage at the model's rate instead of an estimated Claude plan figure.

The SSH executor reads `GET /v1/providers` at the preflight of a Worker whose `llmProviders` lists `anthropic` and records the kind of the Gateway's Anthropic credential with the Worker. A Gateway that holds no Anthropic credential fails that preflight with a `gateway` capability error, and a Gateway too old to answer keeps the Claude plan pool with a warning. `AttemptRequest` (`@usine/durable/attempt-runtime`) requires `gatewayCredential`, an Effect that reads the Worker's recorded kind for a Claude Code brain and none otherwise. The `subagent` tool runs it as each child starts and records the kind on the child's `ChildSession`, so a preflight while an Attempt runs applies to its next child and an earlier child keeps its kind; the Pi and Codex adapters keep it when they rebuild a child's session with its resolved model.
