---
title: Move an instance to another machine
description: Transfer stored state, credentials, and recovery metadata without duplicate execution.
---

Move an instance while keeping its configuration, run history, and recoverable attempts.

## Prerequisites

Access to both machines, the same usine version on the destination or one supporting forward migration, a prepared remote-worker connection, and a destination instance folder on persistent storage.

## Procedure

1. Run `usine status` on the source and install the required version on the destination. Stop the source orchestrator and keep it stopped:

   ```sh
   usine stop
   ```

   Use `--force` only if the destination must reattach active attempts. Only one orchestrator may run the instance.

2. Copy the instance folder as its destination owner, excluding dependencies, logs, backups, and process records:

   ```sh
   rsync -a --chmod=go-rwx --exclude node_modules/ --exclude .usine/usine.log \
     --exclude .usine/backups/ --exclude .usine/instance.lock \
     --exclude .usine/instance.pid --exclude .usine/instance.json \
     ./ usine-orchestrator:factory/
   ```

   Keep both databases, `.env`, App credentials, `.usine/instance-id`, worker state, SSH recovery records, known-hosts files, and `.usine/attempt-connections/`.

3. Copy the referenced SSH keys and trusted host entries. Supply the Pi parent credential for the destination service user, with private file permissions. A copied refresh token must have only one active owner; alternatively, create a fresh login on the destination.
4. Update `.env` for the destination origin and every credential variable used by workers. Adjust fixed-worker firewalls for the destination’s address if needed.
5. Start `usine up` or the configured service on the destination and inspect startup recovery.

## Check the result

`usine status` reports the destination process. The expected configuration and history appear in the UI, and retained attempts reattach or retry from salvage. The source remains stopped.
