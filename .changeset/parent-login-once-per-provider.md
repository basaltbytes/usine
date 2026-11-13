---
"@usine/durable": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

The coordinator brain check of a configuration save, reload, or start checks the credential's login once per provider, however many agents, parent models, and efforts use that provider, and still names each refused agent. The 10-second limit covers the whole check, and for `usine config` commands it also covers loading the parent models, so a slow load refuses the write with `ValidationTimeoutError` and stores no revision. `@usine/durable/parent` adds `sharedParentLogin` and an optional `login` argument to `resolveParent`.
