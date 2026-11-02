---
title: Back up instance state
description: Copy both databases and the files needed for instance recovery.
---

Create a recoverable copy of configuration, run history, and attempt recovery metadata.

## Prerequisites

Access to the instance folder, an existing backup directory on persistent storage, and a new destination file name. The database backup can run while the orchestrator is active.

## Procedure

1. From the instance folder, create a backup:

   ```sh
   usine backup /backups/instance.sqlite
   ```

2. Confirm the command reports both `instance.sqlite` and `instance.durable.sqlite`. An instance without durable storage reports only its runtime backup.
3. Copy `.env`, `.usine/github-app.json`, `.usine/instance-id`, `.usine/attempt-connections/`, `.usine/known-hosts/`, and `.usine/ssh-workers/` to protected backup storage. Include referenced SSH keys and parent credentials through your credential backup process.
4. If you need to preserve active local checkouts, stop the orchestrator before copying `.usine/workers/`. Keep the snapshot and credential records together.

## Check the result

The backup files exist with owner-only access and the command did not overwrite an existing backup. The runtime database includes configuration revisions, events, runs, and transcripts; the durable database includes Pi parent tasks.

An export is useful for configuration review, but excludes history and pause state. [Restore instance state](/guides/restore-instance-state/) describes restoring the databases. Transcripts can contain repository content and tool output; protect them with the same access controls as source code.
