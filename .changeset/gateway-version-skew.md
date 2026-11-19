---
"@usine/core": minor
"@usine/agents": patch
"@usine/executor": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

An orchestrator upgraded before its gateway keeps attempts running. Preflight reads the gateway's provider report: while the gateway reports `anthropic` and `openai` instead of protocol IDs, attempts on its workers call `/anthropic` and `/openai/v1`, and the orchestrator logs a warning once for each worker. The coordinator and supervisor model route reads the same report when it opens and uses those prefixes too, as it does for a gateway without the report. After the gateway is upgraded, the next preflight switches attempts to `/anthropic-messages` and `/openai-responses/v1`.

`PreflightReport.gatewayUpgrade` and `MachineCheck.gatewayUpgrade` say why a worker's gateway is older than the orchestrator: it serves only the provider prefixes, or it has no provider-credentials admin API. Needs attention shows each such worker as a `WorkerGatewayNeed`, **Gateway upgrade needed**, without blocking its attempts. `GatewayAdmin.providers` returns the reported providers with the path prefixes the gateway serves, and `GatewayAdmin.servesProviderCredentials` checks the provider-credentials route and logs a warning when the route answers with an error other than 404.

When a gateway answers 404 for the provider-credentials route, Settings > Provider connections says that the gateway is older than the orchestrator and names the `@usine/gateway` version that the server depends on. The server logs a provider destination's error when it changes rather than on every poll.

`@usine/core` exports `GATEWAY_LEGACY_PROVIDERS`, `gatewayLlmProtocolOf`, and `GatewayLlmProtocolFromName`, which read a gateway slot's provider name from before protocol slots as its protocol. A harness credential's `gatewayPath` must start with its protocol.
