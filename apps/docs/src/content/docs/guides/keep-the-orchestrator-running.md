---
title: Keep the orchestrator running
description: Run the orchestrator in the background and prevent machine sleep.
---

## Start the orchestrator

From the instance folder, start the orchestrator in the background:

```sh
usine up --detach
```

It writes output to `.usine/usine.log`. Manage it from the instance folder:

```sh
usine status
usine restart
usine stop
```

See [Operate runs](/guides/operate-runs/#stop-the-orchestrator) for draining and upgrades.

## Keep the machine awake

The orchestrator must keep running while runs are open. A sleep closes its SSH connections to workers and to the gateway: after the machine wakes, a remote Claude Code child resumes its session, and a Codex child fails. On macOS, `usine up` warns at startup if the Mac can sleep. For a factory that runs unattended, [run the orchestrator on a server](/guides/run-the-orchestrator-on-a-server/) instead of a laptop. To keep a Mac awake:

- Run `caffeinate -s` in another terminal while runs are open. It keeps a Mac on AC power awake until you stop it. To stop it with the orchestrator, run `caffeinate -s -w "$(cat .usine/instance.pid)"` from the instance folder.
- Turn off system sleep on AC power with `sudo pmset -c sleep 0`.

Closing a laptop's lid also puts it to sleep, unless it runs in closed-display mode with power and an external display.
