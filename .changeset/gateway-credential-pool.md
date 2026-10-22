---
"@usine/core": minor
"@usine/gateway": minor
---

The gateway's admin API reports the LLM providers it holds a credential for. `GET /v1/providers` answers with an `LlmProviderList` (`@usine/gateway/admin`): each provider with the kind of its credential, `api-key` or `subscription`, and never the credential itself. It reads the providers in force, so the answer follows a reload. `@usine/core/worker` adds `GatewayCredentialKind`, the two kinds.
