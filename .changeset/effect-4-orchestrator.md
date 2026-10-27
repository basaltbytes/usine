---
"@usine/orchestrator": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)). The operator API still answers a request body with an unknown key with 400 and `InvalidRequestError`, through `HttpApi.PayloadParseOptions` on its group. Effect 4.0 ignores the payload annotations that did this before.
