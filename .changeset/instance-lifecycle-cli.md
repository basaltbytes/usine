---
"@usine/server": minor
---

The CLI manages a running instance. `usine up` writes `.usine/instance.json` with its PID, port, version, start time, and command line, next to `.usine/instance.pid`, and removes both when it exits.

- `usine status` reports whether `usine up` runs, its PID, address, engine version, uptime, open runs, and a newer pinned version on npm. It exits with status 3 if none runs.
- `usine stop [--timeout <seconds>] [--force]` sends `SIGTERM` and waits for the drain. A repeated `stop` doesn't end the drain; `--force` does.
- `usine restart` stops the instance and starts its recorded command line in the background, with the output in `.usine/usine.log`. `usine up --detach` does the same start for a stopped instance.
- `usine upgrade [<version>] [--check]` backs up the stores into `.usine/backups/`, moves the `@usine/*` pins in `package.json`, installs them with the instance's package manager, commits the change, and restarts. For an engine outside the instance, such as a checkout, it changes nothing and says how to update it.

`restart` and `upgrade` refuse while a run has a running attempt, unless `--force`, and when the shell lacks a gateway's admin token variable.
