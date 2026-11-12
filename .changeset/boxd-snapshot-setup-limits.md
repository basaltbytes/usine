---
"@usine/server": patch
---

`infra/boxd/build-snapshot.mjs` limits the setup on the temporary machine. When the setup runs longer than 20 minutes, or the minutes that `--setup-timeout` sets, or prints nothing for 5 minutes, the script stops it, logs the egress allowlist that boxd reports for the machine, and fails with the setup's last 20 output lines. apt gives up on a connection after 30 seconds without data, and `apt-get update` and the Tailscale installer run once more if they fail or don't finish in time. On an interrupt, the script logs `Interrupted; deleting the temporary machine` and deletes the machine at once over a connection of its own. After it lifts the machine's egress allowlist, the script waits five seconds and fails unless boxd still reports the allowlist lifted. Each log line starts with the time.
