---
"@usine/server": minor
---

`usine up` takes `--log-level <level>`, or `USINE_LOG_LEVEL`, with `trace`, `debug`, `info`, `warn`, or `error`, in any case. The default stays `info`. Use `debug` to see the lines that say why usine skipped or deferred something, such as a run left out of **Needs attention** or a pull request that a poll didn't fetch again. An unknown level stops `usine up` with the usage. `usine up --detach`, `usine restart`, and `usine upgrade` start the new process with the level of the recorded launch.
