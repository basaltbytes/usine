---
title: Keep the orchestrator running
description: Start a detached instance and keep its machine awake.
---

Run an existing instance without keeping its terminal open.

## Prerequisites

An initialized instance on persistent storage, its credentials in the instance environment, and access as the Unix user that owns the instance.

## Procedure

1. Change to the instance folder and start the detached orchestrator:

   ```sh
   usine up --detach
   ```

2. Inspect its status and output:

   ```sh
   usine status
   tail -n 80 .usine/usine.log
   ```

3. On macOS, keep AC-powered system sleep off while work is open. Run `caffeinate -s` in another terminal, or configure the machine’s power settings. Closing a laptop lid can still cause sleep.

## Check the result

`usine status` reports the PID, version, uptime, listener, and open runs. The log updates as work proceeds. Use [a server deployment](/guides/run-the-orchestrator-on-a-server/) for unattended operation.

Use `usine stop` to drain running attempts, and `usine restart` to restart an idle instance. `--force` interrupts the wait; the next start reattaches retained attempts. [CLI lifecycle commands](/reference/cli/) describe timeouts.
