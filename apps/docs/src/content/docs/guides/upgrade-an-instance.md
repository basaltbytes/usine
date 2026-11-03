---
title: Upgrade an instance
description: Upgrade a managed server or a project-local package installation.
---

Install a selected usine release and verify the restarted instance.

## Prerequisites

Access to the instance machine, a recoverable backup, and either a global installation managed by systemd with the upgrade helper or an instance-local registry pin. A checkout installation must be pulled and built separately.

## Procedure

1. From the instance folder, inspect the running and available versions:

   ```sh
   usine upgrade --check
   ```

2. For a managed global server, choose **Configuration > Settings** and set upgrade channel `latest` or `next` and mode `propose`, `automatic`, or `off`. Proposed upgrades appear there. Automatic upgrades wait for admitted attempts to finish.
3. Request the upgrade:

   ```sh
   usine upgrade
   ```

   Use `usine upgrade <version>` to select a release. `--force` requests immediate restart and reattachment. Local pin upgrades refuse running attempts unless forced; global managed upgrades wait for idle by default.
4. For systemd, inspect **Settings** and `journalctl -u usine-upgrade.service -f` for the final outcome. For local pins, inspect the command output and `.usine/usine.log`.

## Check the result

`usine status` reports the selected version, and the authenticated UI loads. The managed helper verifies `/api/version` and waits up to 180 seconds for `/api/ready` after recovery. Failed managed installation or readiness restores the prior package and database backup; inspect its recorded failure before retrying.

Managed upgrades check that required packages resolve before draining. The helper backs up both stores before changing packages and requires free space on both the backup and instance filesystems equal to at least twice the combined database and WAL file sizes, so rollback can stage database copies locally even with external backups. If space is insufficient, it records a failed upgrade with the folder to clean and leaves the server and packages unchanged. Instance-local upgrades back up stores, change package pins, install dependencies, commit the pin change, and restart. A failed local installation restores manifests and lockfiles; follow the CLI’s recovery instructions if startup fails.

Startup applies runtime database migrations before readiness. The transcript migration builds an index over stored envelope tags and backfills session usage and billing-pool limits. This requires a one-time pass over historical transcripts and adds disk space for the index and summary tables. It preserves conversations and reported usage. Allow startup to finish within the managed helper's readiness window.

## Managed upgrade backups

The helper creates private `backup.XXXXXXXX` directories under `.usine/upgrade/` in the instance folder. After a successful upgrade, it keeps the newest three backups, always including the current upgrade backup, and removes older ones. Failed upgrades and rollbacks retain all backups. The helper journal reports backup paths and cleanup failures. After a backup or space-check failure, free the required space and restart the server service to resume attempt admission before retrying the upgrade.

To store backups outside the instance folder or change the retention count, run `sudo systemctl edit usine-upgrade.service` and add a drop-in:

```ini
[Service]
Environment="USINE_UPGRADE_BACKUP_DIR=/var/backups/usine/factory"
Environment="USINE_UPGRADE_BACKUP_KEEP=3"
```

Use an absolute directory dedicated to this instance. The helper service user must be able to create and write the directory. `USINE_UPGRADE_BACKUP_KEEP` accepts integers from 1 to 999999999. These variables belong to the helper service environment; adding them to the instance’s `.env` does not configure the helper. Run `sudo systemctl daemon-reload` after saving the drop-in. The next upgrade uses the new values.

Changing the backup directory leaves backups in the previous directory available for manual removal. Keep any backups you need for longer-term recovery in separate storage.

[CLI upgrade reference](/reference/cli/#usine-upgrade) describes flags and installation requirements.
