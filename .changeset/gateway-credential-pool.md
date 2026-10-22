---
"@usine/core": minor
"@usine/gateway": minor
"@usine/orchestrator": minor
---

The gateway's admin API reports the LLM providers it holds a credential for. `GET /v1/providers` answers with an `LlmProviderList` (`@usine/gateway/admin`): each provider with the kind of its credential, `api-key` or `subscription`, and never the credential itself. It reads the providers in force, so the answer follows a reload. `@usine/core/worker` adds `GatewayCredentialKind`, the two kinds.

`ChildSession` records `gatewayCredential`, the kind of credential the Gateway in front of the child's Worker paid its model requests with; it is none for a child that paid with its harness's own login and in transcripts recorded before it existed. `brainPool(brain, gatewayCredential)` takes that kind, and the new `sessionPool(session)` reads the pool from a recorded session: a Claude Code child its Gateway paid with an API key is in `apiKeys`, every other Claude Code child in `claudePlan`. The orchestrator's `RunUsageView` and Task usage use `sessionPool`, so those children are priced as API-key usage at the model's rate instead of an estimated Claude plan figure.
