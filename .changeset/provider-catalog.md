---
"@usine/core": minor
"@usine/gateway": minor
"@usine/agents": minor
"@usine/config": minor
"@usine/executor": minor
"@usine/durable": minor
"@usine/orchestrator": minor
"@usine/server": minor
---

A model provider is one catalog entry, and the gateway serves one slot for each. An entry gives the provider's ID, its slot at the gateway, its label, each wire protocol's upstream, routes, and key header, the credentials it accepts, the request headers that pass to the upstream, and the variable that replaces its upstreams. One key can serve several protocols: each path under the slot goes to the upstream of the protocol that serves it, with the key in that protocol's header. A provider with a static key needs only its entry. The Anthropic and OpenAI providers are entries with the slots `anthropic-messages` and `openai-responses`, and behave as before, subscription logins included.

- `@usine/core/agent/provider`: `ModelProvider`, `ProviderProtocol`, `KeyHeader`, `ApiKeyCredential`, `SubscriptionCredential`, `ModelProviderCatalog`, the `ModelProviderId`, `GatewaySlot`, `WireProtocol`, `RoutePattern`, `HeaderName`, `GatewayVariable`, and `UpstreamBase` schemas, and `modelProviders`, the catalog of the `anthropic` and `openai` entries. `/worker` no longer exports `GatewayLlmProvider`, `GatewayLlmProtocol`, `GATEWAY_LEGACY_PROVIDERS`, `gatewayLlmProtocolOf`, or `GatewayLlmProtocolFromName`; `ModelProviderCatalog.find` and `slotFromName` read a slot or a provider ID.
- `@usine/agents/harness`: `HarnessDescriptor.providers` lists the providers a harness can use, in the order it prefers them; `HarnessCredential` drops `provider`, `protocol`, `label`, `apiHost`, and `apiKeyBaseUrl`, and its `gatewayPath` becomes `slotPath`, the path under the slot. `HarnessCatalog.providers` lists each declared provider once, `gatewayProvider` returns the provider whose gateway credential a harness uses, and the catalog refuses a provider ID that two harnesses define differently. A pool route `gateway-api-key` or `gateway-subscription` needs a provider of the harness that accepts that kind of credential.
- `@usine/gateway`: `GatewaySettings.catalog` holds the providers it serves, and `LlmProviders` holds an `LlmProvider` (an `ApiKey`, `AnthropicSubscriptionToken`, or `ChatGptLogin`, and an optional upstream) by slot; `AnthropicApiKey`, `OpenAiApiKey`, `AnthropicProvider`, and `OpenAiProvider` are removed. The gateway reads each provider's credential from the variables of its entry, reads a caller token from each protocol's key header, and refuses paths outside the entry's routes. `GET /v1/providers` also lists every slot it serves, with its routes, as `slots`. `provider-credentials.json` keeps its format.
- `@usine/config`: `gateway.llm_providers` accepts the slots of the harness catalog's providers, and their IDs as before slots. `ProviderApiKeys` maps a catalog provider ID to a variable, so a provisioner's `api_keys` accepts any catalog provider and refuses an unknown one; stored `anthropic` and `openai` keys read as before.
- `@usine/executor`: the gateway preflight refuses a gateway that doesn't serve a listed slot, or a route under it that the catalog declares, and asks to upgrade the gateway to the orchestrator's release; it reports a gateway that doesn't list its slots in `gatewayUpgrade`. `ProviderApiKeys` is a record by provider ID, and `provisionedApiKey` returns the key with its provider. `GatewayModelRoute.request` takes a slot and a path, and replaces `countTokens`. The supervisor relay forwards a model request to any route of a catalog provider.
- `@usine/durable`: `GatewayModelTransport` takes a slot and, for requests, a path.
- `@usine/orchestrator`: provisioner views replace `anthropicKeyEnv` and `openaiKeyEnv` with `apiKeys`, the variable of each provider's key by provider ID.
- `@usine/server`: the operator API's provisioner views have `apiKeys`, and the worker page lists each provider's API key variable.
