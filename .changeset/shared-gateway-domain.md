---
"@usine/gateway": patch
---

`@usine/gateway` re-exports `GatewayDomain` from `@usine/core/worker`, so `USINE_GATEWAY_DOMAIN` and a worker's `gateway.domain` use the same schema. The export doesn't change for callers.
