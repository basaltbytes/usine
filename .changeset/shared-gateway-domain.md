---
"@usine/gateway": patch
---

`@usine/gateway` re-exports `GatewayDomain` from `@usine/core/worker` instead of defining its own copy, so `USINE_GATEWAY_DOMAIN` and a Worker's `gateway.domain` in `usine.yaml` are checked by the same schema. The export and what it accepts are unchanged for callers.
