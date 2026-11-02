---
title: Restore instance state
description: Restore a matching pair of database backups with recovery files.
---

Restore an instance from a saved backup.

## Prerequisites

Access to the instance machine, a matching runtime and durable backup pair, recovery metadata and credentials, and the same usine version used for the backup or a version supporting its forward migrations.

## Procedure

1. Stop the orchestrator with `usine stop` and verify it is stopped.
2. Move the current `.usine/runtime.sqlite` and `.usine/durable.sqlite` aside with their `-wal` and `-shm` files.
3. Copy the backup files to those database paths. Restore the instance identity, attempt connection records, known-hosts records, worker state, and credential files from the corresponding backup.
4. Start `usine up` or the instance service and inspect startup recovery before enabling new work.

## Check the result

The expected configuration revision and run history appear in the UI. Recovery reconciles retained attempts using their recorded connections. An older event record can cause work completed after the backup to run again; inspect affected items before resuming loops.
