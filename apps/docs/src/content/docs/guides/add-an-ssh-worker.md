---
title: Add an SSH worker
description: Connect a fixed Linux worker and verify its attempt container.
---

Run attempts on a fixed Linux machine over SSH.

## Prerequisites

Instance admin access, an instance using SSH workers, a Linux machine with Git, rootless Podman or Docker, a writable worker root, an SSH key, and the child harness credentials. Pi children require local workers.

## Procedure

1. Prepare the machine with the [worker image and cloud-init scripts](https://github.com/basaltbytes/usine/tree/main/infra/hetzner). For a Hetzner machine, create a key and run the worker script from a matching usine checkout:

   ```sh
   ssh-keygen -t ed25519 -f ~/.ssh/usine_worker -C usine-worker
   ./infra/hetzner/create-worker.sh worker-one fsn1 203.0.113.10 ~/.ssh/usine_worker.pub
   ```

   Replace the orchestrator’s public address and use the worker address printed by the script in the next step.

2. Connect to record the trusted host key and wait for cloud-init:

   ```sh
   ssh -i ~/.ssh/usine_worker usine@203.0.113.20 cloud-init status --wait
   ```

3. Log in as the worker user for each rostered harness, unless a gateway supplies its credential:

   ```sh
   ssh -t -i ~/.ssh/usine_worker usine@203.0.113.20
   claude auth login
   codex login --device-auth
   ```

4. Open **Configuration > Workers > New**. Enter a name, select kind `ssh`, and set destination `usine@203.0.113.20`, identity file `~/.ssh/usine_worker`, root `/home/usine/.usine`, and concurrency `1`. Save.
5. Inspect preflight. Fix any image, UID, resource-control, tool, or login error before running work.

## Check the result

The worker reports passing preflight, its selected runtime, and applied container limits. Start a test run and confirm its attempt lists the SSH worker.

For Docker and Podman, the server logs whether the attempt image is present and how long inspection and pulling take. A missing image produces a warning and is pulled before the first container starts. Other Podman inspection errors stop preparation and report a container capability error.

For later edits, run `EDITOR=vi usine config edit worker worker-one`. [Attempt containers](/reference/configuration/workers/#attempt-container) explains image requirements and shared caches. [Configure a gateway](/guides/configure-a-gateway/) to proxy credentials.

## Codex connection recovery

Remote Codex children continue running through an SSH disconnect. usine reconnects to the same app-server and reads buffered output. If the supervisor or app-server exits after the thread is saved, including an unexpected exit with code 0 or an exit during the first turn request, usine stops the remaining process group and confirms termination before resuming the thread once. Recovery resends the original task if the saved thread has no user message; otherwise, it continues the saved work. Recovery replays unread operator guidance in order and reports delivery after the recovered turn accepts it. A paused or idle child waits for operator guidance after recovery and includes any unread messages when it resumes. A second failure records an infrastructure failure, which takes precedence over earlier child questions or blockers and permits an automatic retry. The worker needs Node.js on its command path, including inside the attempt container.
