---
"@usine/server": patch
---

`usine status`, `usine stop`, `usine restart`, and `usine upgrade` read the `.usine/instance.json` of a `usine up` that started before `--log-level` existed. They ignored that record as unreadable, so `usine restart` refused the instance. `usine restart` now starts it again at the `info` log level.

`usine restart` also restarts an instance whose record is missing or still unreadable, such as one that `@usine/server` 0.3.0 started, which writes only `.usine/instance.pid`. It stops that process and starts `usine up` as `usine up --detach` without flags would, on the port that the shell or `.env` sets. Before, it refused and said to run `usine stop`, then `usine up --detach`.
