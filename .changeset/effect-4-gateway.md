---
"@usine/gateway": minor
---

Requires `effect` 4.0.6 instead of 4.0.0-rc.111, and depends on `@effect/platform-node` and `@effect/platform-node-shared` 4.0.6 ([#494](https://github.com/basaltbytes/usine/issues/494)).

The admin API still answers an attach or renew body with an unknown key with 400, through `HttpApi.PayloadParseOptions` on the attachments group. Effect 4.0 ignores the payload annotation that did this before.

Effect's Node server now aborts a reverse-proxy response whose upstream body fails after its headers, so the gateway no longer destroys the response itself. It still logs `The reverse proxy response body failed`. A listener bound to `::` reports its host as `::` instead of `0.0.0.0`.
