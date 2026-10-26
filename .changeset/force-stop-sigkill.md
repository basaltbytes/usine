---
"@usine/server": patch
---

`usine stop --force`, `usine restart --force`, and `usine upgrade --force` send `SIGKILL` to an orchestrator that still runs after `--timeout` ([#573](https://github.com/basaltbytes/usine/issues/573)), and print `usine (pid <pid>) did not exit within <timeout>. Sent SIGKILL: the next start reattaches the running attempts.` Before, the command exited with status 1 and suggested `--force`, which was already set. `restart` and `upgrade` then continue with the start. If the process still runs 5 seconds after `SIGKILL`, the command fails with `KillTimeoutError`.
