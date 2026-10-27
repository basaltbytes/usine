---
"@usine/server": minor
---

`usine status`, `usine stop`, `usine restart`, and `usine upgrade` manage an orchestrator that a systemd service runs with `systemctl` ([#609](https://github.com/basaltbytes/usine/issues/609)). `usine up` records the system service whose cgroup it runs in, from `/proc/self/cgroup`, as `systemdUnit` in `.usine/instance.json`. If `systemctl show` reports the process as that service's main process, the commands start the drain with `systemctl stop --no-block`, so that systemd doesn't restart the service, and start it again with `systemctl start`, waiting until the new process answers. A start whose service fails or waits to restart is stopped with `systemctl stop --no-block`, so that a failing start, such as a failed migration, doesn't repeat, also when `systemctl start` itself fails. `usine status` adds a `service` line. A failed `systemctl` command, such as one that the user may not run, stops the command with status 1 and names it.
