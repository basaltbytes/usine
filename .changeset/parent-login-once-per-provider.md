---
"@usine/durable": minor
"@usine/orchestrator": patch
"@usine/server": patch
---

The coordinator brain check of a configuration save, reload, or start checks the credential's login once per provider, however many agents, parent models, and efforts use that provider, and still names each refused agent. When Pi selects the parent model, it lists the available models once per check, not once per agent. The 10-second limit covers the whole check, and for `usine config` commands it also covers loading the parent models, so a slow load refuses the write with `ValidationTimeoutError` and stores no revision. `@usine/durable/parent` adds `sharedParentAnswers` and an optional `answers` argument to `resolveParent`.
