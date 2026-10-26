---
"@usine/server": patch
---

`usine status`, `usine stop`, `usine restart`, and `usine upgrade` read the `.usine/instance.json` of a `usine up` that started before `--log-level` existed. They ignored that record as unreadable, so `usine restart` refused the instance. `usine restart` now starts it again at the `info` log level.
