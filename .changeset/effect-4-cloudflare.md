---
"@usine/cloudflare": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111 ([#494](https://github.com/basaltbytes/usine/issues/494)). The sandbox API still answers a create or credentials body with an unknown key with 400, through `HttpApi.PayloadParseOptions` on the sandbox group. Effect 4.0 ignores the payload annotation that did this before.
